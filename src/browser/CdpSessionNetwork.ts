import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { compositeKey } from "../domain/unicodeCodePointOrder.js";
import type {
  ObserveWebSessionInput,
  WebSessionNetwork,
} from "../domain/browserSession.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import type { CdpEvent } from "./CdpConnection.js";
import {
  decodeBase64,
  exclusionReasonForUrl,
} from "./CdpCaptureEventHelpers.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  numberValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

/** One observed target session whose Network events are retained. */
export type SessionTarget = WebSessionNetwork["targets"][number] & {
  readonly sessionId: string | undefined;
};

/** One HTTP request hop observed on an in-scope target session. */
export interface RecordedExchange {
  readonly target: SessionTarget;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string | null;
  readonly startedAtMs: number | null;
  readonly timestamp: number | null;
  readonly requestHeaders: UnknownRecord | undefined;
  /** CDP reported a request body, whether or not it was retained. */
  readonly hasBody: boolean;
  response: UnknownRecord | undefined;
  responseTimestamp: number | null;
  redirectUrl: string | null;
  redirectExcluded: boolean;
  decodedBytes: number;
  endTimestamp: number | null;
  error: string | null;
}

/** One in-scope WebSocket and its ordered frames. */
export interface RecordedSocket {
  readonly target: SessionTarget;
  readonly url: string;
  startedAtMs: number;
  wallOffset: number | null;
  requestHeaders: UnknownRecord | undefined;
  response: UnknownRecord | undefined;
  readonly messages: {
    readonly type: "send" | "receive";
    readonly time: number;
    readonly opcode: number;
    readonly bytes: number | null;
  }[];
}

/** Shared state for one observation window's network evidence. */
export interface SessionNetworkContext {
  readonly options: NonNullable<ObserveWebSessionInput["network"]>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly completeness: CdpCaptureCompleteness;
  readonly limitations: string[];
}

/** Record in-scope HTTP and WebSocket traffic across main-frame navigations. */
export class CdpSessionNetwork {
  readonly targets: SessionTarget[] = [];
  readonly exchanges: RecordedExchange[] = [];
  readonly sockets: RecordedSocket[] = [];
  readonly #sessions = new Map<string | undefined, SessionTarget>();
  readonly #active = new Map<string, RecordedExchange>();
  readonly #socketsById = new Map<string, RecordedSocket>();
  readonly #excludedSockets = new Map<string, BrowserExclusionReason>();
  #stopped = false;

  constructor(readonly context: SessionNetworkContext) {}

  /** Retain Network events from one authorized target session. */
  register(target: SessionTarget): void {
    this.targets.push(target);
    this.#sessions.set(target.sessionId, target);
  }

  ingest(event: CdpEvent): void {
    const target = this.#sessions.get(event.sessionId);
    const params = recordValue(event.params);
    const requestId = cdpStringValue(params?.requestId);
    if (this.#stopped || target === undefined || requestId === undefined)
      return;
    const key = compositeKey([target.target_id, requestId]);
    if (event.method.startsWith("Network.webSocket"))
      this.#socketEvent(target, key, event.method, params);
    else this.#httpEvent(target, key, event.method, params);
  }

  #httpEvent(
    target: SessionTarget,
    key: string,
    method: string,
    params: UnknownRecord | undefined,
  ): void {
    const exchange = this.#active.get(key);
    switch (method) {
      case "Network.requestWillBeSent":
        return this.#request(target, key, params);
      case "Network.responseReceived":
        if (exchange === undefined) return;
        exchange.response = recordValue(params?.response);
        exchange.responseTimestamp = numberValue(params?.timestamp) ?? null;
        return;
      case "Network.dataReceived":
        if (exchange !== undefined)
          exchange.decodedBytes += Math.max(
            0,
            numberValue(params?.dataLength) ?? 0,
          );
        return;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        return this.#ended(key, method, params);
    }
  }

  #socketEvent(
    target: SessionTarget,
    key: string,
    method: string,
    params: UnknownRecord | undefined,
  ): void {
    const socket = this.#socketsById.get(key);
    if (method === "Network.webSocketCreated")
      return this.#socketCreated(target, key, params);
    if (
      method === "Network.webSocketFrameSent" ||
      method === "Network.webSocketFrameReceived"
    )
      return this.#frame(key, method, params);
    if (socket === undefined) return;
    if (method === "Network.webSocketHandshakeResponseReceived")
      socket.response = recordValue(params?.response);
    const wallTime = numberValue(params?.wallTime);
    if (
      method !== "Network.webSocketWillSendHandshakeRequest" ||
      wallTime === undefined
    )
      return;
    const timestamp = numberValue(params?.timestamp);
    socket.requestHeaders = recordValue(recordValue(params?.request)?.headers);
    socket.startedAtMs = wallTime * 1000;
    if (timestamp !== undefined) socket.wallOffset = wallTime - timestamp;
  }

  /** Stop retaining events. */
  stop(): void {
    this.#stopped = true;
  }

  #request(
    target: SessionTarget,
    key: string,
    params: UnknownRecord | undefined,
  ): void {
    const request = recordValue(params?.request);
    const timestamp = numberValue(params?.timestamp) ?? null;
    const url = allowedSanitizedUrl(request?.url, this.context.allowedOrigins);
    const previous = this.#active.get(key);
    const redirect = recordValue(params?.redirectResponse);
    // CDP reports a redirect hop's response with the request that follows it.
    if (previous !== undefined && redirect !== undefined) {
      previous.response = redirect;
      previous.responseTimestamp = timestamp;
      previous.endTimestamp = timestamp;
      previous.redirectUrl = url?.url ?? null;
      previous.redirectExcluded = url === undefined;
    }
    this.#active.delete(key);
    if (request === undefined || url === undefined) {
      this.context.completeness.exclude(
        "network_requests",
        request === undefined
          ? "invalid_protocol_value"
          : exclusionReasonForUrl(cdpStringValue(request.url)),
      );
      return;
    }
    // A continuation whose predecessor began before attach or out of scope.
    if (redirect !== undefined && previous === undefined)
      this.context.completeness.attachLimited("network_requests");
    const exchange = openExchange(target, params, request, url.url);
    this.exchanges.push(exchange);
    this.#active.set(key, exchange);
  }

  #ended(key: string, method: string, params: UnknownRecord | undefined): void {
    const exchange = this.#active.get(key);
    if (exchange === undefined) return;
    this.#active.delete(key);
    exchange.endTimestamp = numberValue(params?.timestamp) ?? null;
    if (method !== "Network.loadingFailed") return;
    const error = cdpStringValue(params?.errorText) ?? "";
    exchange.error = /^net::ERR_[A-Z0-9_]{1,100}$/u.test(error)
      ? error
      : "net::ERR_FAILED";
  }

  #socketCreated(
    target: SessionTarget,
    key: string,
    params: UnknownRecord | undefined,
  ): void {
    const rawUrl = cdpStringValue(params?.url);
    const excluded = webSocketExclusion(rawUrl, this.context.allowedOrigins);
    if (rawUrl === undefined || excluded !== undefined) {
      this.#excludedSockets.set(key, excluded ?? "invalid_protocol_value");
      this.context.completeness.exclude(
        "websocket_connections",
        excluded ?? "invalid_protocol_value",
      );
      return;
    }
    const socket: RecordedSocket = {
      target,
      url: sanitizeBrowserUrl(rawUrl).url,
      startedAtMs: Date.now(),
      wallOffset: null,
      requestHeaders: undefined,
      response: undefined,
      messages: [],
    };
    this.#socketsById.set(key, socket);
    this.sockets.push(socket);
  }

  #frame(key: string, method: string, params: UnknownRecord | undefined): void {
    const socket = this.#socketsById.get(key);
    if (socket === undefined) {
      // Frames of sockets opened before attach carry no URL to authorize.
      this.context.completeness.exclude(
        "websocket_frames",
        this.#excludedSockets.get(key) ?? "unattributed_origin",
      );
      return;
    }
    const response = recordValue(params?.response);
    const payload = cdpStringValue(response?.payloadData) ?? "";
    const opcode = Math.max(0, Math.trunc(numberValue(response?.opcode) ?? 0));
    const timestamp = numberValue(params?.timestamp);
    socket.messages.push({
      type: method === "Network.webSocketFrameSent" ? "send" : "receive",
      time:
        socket.wallOffset !== null && timestamp !== undefined
          ? socket.wallOffset + timestamp
          : Date.now() / 1000,
      opcode,
      bytes:
        opcode === 1
          ? Buffer.byteLength(payload)
          : (decodeBase64(payload)?.byteLength ?? null),
    });
  }
}

const openExchange = (
  target: SessionTarget,
  params: UnknownRecord | undefined,
  request: UnknownRecord,
  url: string,
): RecordedExchange => {
  const wallTime = numberValue(params?.wallTime);
  return {
    target,
    method: cdpStringValue(request.method) ?? "GET",
    url,
    resourceType: cdpStringValue(params?.type) ?? null,
    startedAtMs: wallTime === undefined ? null : wallTime * 1000,
    timestamp: numberValue(params?.timestamp) ?? null,
    requestHeaders: recordValue(request.headers),
    hasBody:
      request.hasPostData === true || typeof request.postData === "string",
    response: undefined,
    responseTimestamp: null,
    redirectUrl: null,
    redirectExcluded: false,
    decodedBytes: 0,
    endTimestamp: null,
    error: null,
  };
};

/** Headers whose whole value is one URL; they are scoped like request URLs. */
const URL_HEADERS = new Set([
  "location",
  "content-location",
  "referer",
  "origin",
]);

/** A URL in a URL-valued header: its text as sent, offset and absolute form. */
export interface HeaderUrlTarget {
  readonly raw: string;
  readonly start: number;
  readonly url: string;
}

/**
 * Targets of a URL-valued header, resolved against its request URL, or
 * undefined when the header carries no URL. Link lists `<target>`s; Refresh
 * names one after its delay, with or without `url=`. A Link or Refresh whose
 * target cannot be parsed yields none, so the caller fails closed.
 */
export const headerUrlTargets = (
  name: string,
  value: string,
  requestUrl: string,
): HeaderUrlTarget[] | undefined => {
  const lower = name.toLowerCase();
  let raws: Array<{ raw: string; start: number }> | undefined;
  if (lower === "link") raws = linkTargets(value);
  else if (lower === "refresh") raws = refreshTarget(value);
  else if (URL_HEADERS.has(lower) && !(lower === "origin" && value === "null"))
    raws = [
      { raw: value.trim(), start: value.length - value.trimStart().length },
    ];
  return raws?.map(({ raw, start }) => ({
    raw,
    start,
    url: URL.canParse(raw, requestUrl) ? new URL(raw, requestUrl).href : raw,
  }));
};

/** An `anchor` link-param: a token or a quoted-string without quoted-pairs. */
const ANCHOR_PARAM =
  /[\t ]*anchor[\t ]*=[\t ]*(?:"([^"\\]*)"|([!#$%&'*+.^_`|~0-9a-z-]+)(?=[\t ]*(?:[;,]|$)))?/iy;

/**
 * RFC 8288 §3.2 makes an `anchor` value a URI-Reference, so it is a target
 * too. Undefined when the param after the `;` at `index` is another one, and
 * null when the anchor's value cannot be read.
 */
const anchorTarget = (
  value: string,
  index: number,
): { raw: string; start: number } | null | undefined => {
  ANCHOR_PARAM.lastIndex = index + 1;
  const anchor = ANCHOR_PARAM.exec(value);
  if (anchor === null) return undefined;
  const [, quoted, token] = anchor;
  const raw = quoted ?? token;
  if (raw === undefined) return null;
  const end = ANCHOR_PARAM.lastIndex - (quoted === undefined ? 0 : 1);
  return { raw, start: end - raw.length };
};

/**
 * Link targets per RFC 8288: comma-separated link-values, each a `<target>`
 * then parameters whose quoted-strings may hold `<`, `>`, `,` and `\`
 * quoted-pairs. A `<` or `>` outside a quoted-string, an unterminated target
 * or quoted-string, or an unreadable `anchor` makes the whole value
 * unparseable and yields none.
 */
const linkTargets = (value: string): Array<{ raw: string; start: number }> => {
  const targets: Array<{ raw: string; start: number }> = [];
  let index = 0;
  for (;;) {
    // Whitespace and empty list elements precede each link-value.
    while (index < value.length && " \t,".includes(value.charAt(index)))
      index += 1;
    if (index === value.length) return targets;
    const close = value.indexOf(">", index);
    if (value[index] !== "<" || close === -1) return [];
    const raw = value.slice(index + 1, close);
    if (raw.includes("<")) return [];
    targets.push({ raw, start: index + 1 });
    for (index = close + 1; index < value.length; index += 1) {
      const char = value[index];
      if (char === ",") break;
      if (char === "<" || char === ">") return [];
      // A read anchor is a token or a quoted-string without quoted-pairs, so
      // the walk below crosses it as it would any other parameter.
      if (char === ";") {
        const anchor = anchorTarget(value, index);
        if (anchor === null) return [];
        if (anchor !== undefined) targets.push(anchor);
      }
      if (char !== '"') continue;
      for (index += 1; value[index] !== '"'; index += 1) {
        if (value[index] === "\\") index += 1;
        if (index >= value.length) return [];
      }
    }
  }
};

/**
 * A Refresh target per the HTML declarative refresh steps: delay, separator,
 * optional `url=`, optionally quoted URL. A bare delay reloads (no URL); any
 * other unparseable value yields none. Chromium ends a quoted URL at its last
 * matching quote, the HTML steps at the first, so a value in which those
 * differ yields none.
 */
const refreshTarget = (
  value: string,
): Array<{ raw: string; start: number }> | undefined => {
  const prefix =
    /^[\t\n\f\r ]*(?:[0-9][0-9.]*|\.[0-9.]*)(?:$|[\t\n\f\r ;,][\t\n\f\r ]*[;,]?[\t\n\f\r ]*(?:url[\t\n\f\r ]*=[\t\n\f\r ]*)?(["']?))/iu.exec(
      value,
    );
  if (prefix === null) return value.trim() === "" ? undefined : [];
  const rest = value.slice(prefix[0].length);
  const close = prefix[1] ? rest.indexOf(prefix[1]) : -1;
  if (prefix[1] && rest.lastIndexOf(prefix[1]) !== close) return [];
  const url = close === -1 ? rest : rest.slice(0, close);
  const start = prefix[0].length + url.length - url.trimStart().length;
  return url.trim() === "" ? undefined : [{ raw: url.trim(), start }];
};

/** WebSocket URLs share the origin of their HTTP(S) handshake. */
const WEBSOCKET_SCHEMES = new Map([
  ["ws:", "http:"],
  ["wss:", "https:"],
]);

const webSocketExclusion = (
  rawUrl: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): BrowserExclusionReason | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl ?? "");
  } catch {
    return rawUrl === undefined ? "invalid_protocol_value" : "unsupported_url";
  }
  const scheme = WEBSOCKET_SCHEMES.get(parsed.protocol);
  if (scheme === undefined) return "unsupported_url";
  parsed.protocol = scheme;
  return allowedOrigins.has(parsed.origin) ? undefined : "disallowed_origin";
};
