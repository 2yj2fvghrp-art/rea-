import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { compositeKey } from "../domain/unicodeCodePointOrder.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import {
  WEB_SESSION_NETWORK_CONTENT_BYTES,
  type ObserveWebSessionInput,
  type WebSessionNetwork,
} from "../domain/browserSession.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import {
  exclusionReasonForUrl,
  isJsonMediaType,
} from "./CdpCaptureEventHelpers.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  numberValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { decodeBase64 } from "./network/Base64.js";

/** One observed target session whose Network events are retained. */
export type SessionTarget = WebSessionNetwork["targets"][number] & {
  readonly sessionId: string | undefined;
};

/**
 * Retained text or base64, or why selected content is absent and, when CDP
 * listed its bytes, their exact count.
 */
export type RecordedContent =
  | { readonly text: string; readonly base64: boolean }
  | { readonly omitted: string; readonly bytes?: number };

/** One HTTP request hop observed on an in-scope target session. */
export interface RecordedExchange {
  readonly target: SessionTarget;
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string | null;
  readonly startedAtMs: number | null;
  readonly timestamp: number | null;
  readonly requestHeaders: UnknownRecord | undefined;
  /** CDP reported a request body, whether or not it was retained. */
  readonly hasBody: boolean;
  postData: RecordedContent | undefined;
  response: UnknownRecord | undefined;
  responseTimestamp: number | null;
  redirectUrl: string | null;
  redirectExcluded: boolean;
  decodedBytes: number;
  /** Encoded body bytes that Network.dataReceived reported. */
  encodedBytes: number;
  endTimestamp: number | null;
  error: string | null;
  body: RecordedContent | undefined;
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
    readonly data: string | null;
    readonly bytes: number | null;
  }[];
}

/** Shared state for one observation window's network evidence. */
export interface SessionNetworkContext {
  readonly connection: CdpConnection;
  readonly signal: AbortSignal | undefined;
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
  readonly #pending = new Set<Promise<void>>();
  #failure: { readonly cause: unknown } | undefined;
  #remainingBytes = WEB_SESSION_NETWORK_CONTENT_BYTES;
  #stopped = false;
  readonly #abandonReads = new AbortController();
  /** Aborted when a worker session ends; its reads will never be answered. */
  readonly #sessionEnds = new Map<string, AbortController>();

  constructor(readonly context: SessionNetworkContext) {}

  /**
   * Network.enable parameters. Chrome repeats inline post data as escaped
   * text and as base64, so the inline size keeps each subresource request
   * event within one CDP message. Chrome ignores it for navigations and
   * inlines their bodies whole.
   */
  get enableParameters(): Readonly<Record<string, number>> {
    return this.context.options.request_bodies
      ? { maxPostDataSize: INLINE_POST_DATA_BYTES }
      : {};
  }

  get retainedContentBytes(): number {
    return WEB_SESSION_NETWORK_CONTENT_BYTES - this.#remainingBytes;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Retain Network events from one authorized target session. */
  register(target: SessionTarget): void {
    this.targets.push(target);
    this.#sessions.set(target.sessionId, target);
  }

  /** Track asynchronous protocol work so failures surface when settling. */
  track(task: Promise<void>): void {
    const tracked = task.then(
      () => undefined,
      (cause: unknown) => {
        this.#failure ??= { cause };
      },
    );
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
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
    else this.#httpEvent(target, key, requestId, event.method, params);
  }

  #httpEvent(
    target: SessionTarget,
    key: string,
    requestId: string,
    method: string,
    params: UnknownRecord | undefined,
  ): void {
    const exchange = this.#active.get(key);
    switch (method) {
      case "Network.requestWillBeSent":
        return this.#request(target, key, requestId, params);
      case "Network.responseReceived":
        if (exchange === undefined) return;
        exchange.response = recordValue(params?.response);
        exchange.responseTimestamp = numberValue(params?.timestamp) ?? null;
        return;
      case "Network.dataReceived":
        if (exchange === undefined) return;
        exchange.decodedBytes += Math.max(
          0,
          numberValue(params?.dataLength) ?? 0,
        );
        exchange.encodedBytes += Math.max(
          0,
          numberValue(params?.encodedDataLength) ?? 0,
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

  /** Stop retaining events; already-started body reads still settle. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    // Bodies are read when loading finishes; say why an unfinished one is absent.
    for (const exchange of this.#active.values())
      if (exchange.response !== undefined && this.#bodySelected(exchange)) {
        exchange.body = { omitted: "Its body was not read." };
        this.context.completeness.unavailable("network_bodies");
      }
  }

  /** Stop waiting for body reads that a terminated target will never answer. */
  abandonReads(): void {
    this.#abandonReads.abort();
  }

  /** Aborted once the observed target has terminated or disconnected. */
  get terminated(): AbortSignal {
    return this.#abandonReads.signal;
  }

  /** Stop waiting for body reads on one ended worker session. */
  endSession(sessionId: string): void {
    this.#sessionEnd(sessionId).abort();
  }

  #sessionEnd(sessionId: string): AbortController {
    let controller = this.#sessionEnds.get(sessionId);
    if (controller === undefined) {
      controller = new AbortController();
      this.#sessionEnds.set(sessionId, controller);
    }
    return controller;
  }

  /** Wait for started protocol work and surface failures it could not classify. */
  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  /** Every retained URL, for resolving declared sensitive query parameters. */
  *retainedUrls(): Iterable<string> {
    for (const target of this.targets)
      if (target.url !== null) yield target.url;
    for (const exchange of this.exchanges) {
      yield exchange.url;
      if (exchange.redirectUrl !== null) yield exchange.redirectUrl;
      yield* this.#headerUrls(exchange.requestHeaders, exchange.url);
      yield* this.#headerUrls(
        recordValue(exchange.response?.headers),
        exchange.url,
      );
    }
    for (const socket of this.sockets) {
      yield socket.url;
      yield* this.#headerUrls(socket.requestHeaders, socket.url);
      yield* this.#headerUrls(
        recordValue(socket.response?.headers),
        socket.url,
      );
    }
  }

  /** In-scope URLs inside headers that the HAR will retain. */
  *#headerUrls(
    headers: UnknownRecord | undefined,
    requestUrl: string,
  ): Iterable<string> {
    if (!this.context.options.header_values || headers === undefined) return;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") continue;
      for (const line of value.split("\n"))
        for (const { url } of headerUrlTargets(name, line, requestUrl) ?? [])
          if (allowedSanitizedUrl(url, this.context.allowedOrigins)) yield url;
    }
  }

  #request(
    target: SessionTarget,
    key: string,
    requestId: string,
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
    const exchange = openExchange(target, requestId, params, request, url.url);
    exchange.postData = this.#postData(request);
    this.exchanges.push(exchange);
    this.#active.set(key, exchange);
  }

  #postData(request: UnknownRecord): RecordedContent | undefined {
    if (!this.context.options.request_bodies) return undefined;
    // postData is the browser's text decoding (UTF-8, else Latin-1) of the
    // exact bytes that postDataEntries lists.
    if (request.postDataEntries !== undefined)
      return this.#postDataBytes(request.postDataEntries);
    const text = cdpStringValue(request.postData);
    if (text !== undefined) return this.#retain(text, false);
    if (request.hasPostData !== true) return undefined;
    this.context.completeness.unavailable("network_bodies");
    return { omitted: "Request body was not exposed with the request event." };
  }

  /** A body from its listed bytes; HAR postData carries UTF-8 text only. */
  #postDataBytes(entries: unknown): RecordedContent {
    const chunks = Array.isArray(entries)
      ? entries.map((entry) => {
          const text = cdpStringValue(recordValue(entry)?.bytes);
          return text === undefined ? undefined : canonicalBase64Bytes(text);
        })
      : [undefined];
    if (chunks.some((chunk) => chunk === undefined)) {
      this.context.completeness.exclude(
        "network_bodies",
        "invalid_protocol_value",
      );
      return { omitted: "CDP returned a malformed request body." };
    }
    const bytes = Buffer.concat(chunks.filter((chunk) => chunk !== undefined));
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      this.context.completeness.unavailable("network_bodies");
      return {
        omitted: `Request body not retained: its ${String(bytes.length)} bytes are not UTF-8, and HAR postData carries text only.`,
        bytes: bytes.length,
      };
    }
    const content = this.#retain(text, false);
    return "text" in content ? content : { ...content, bytes: bytes.length };
  }

  #ended(key: string, method: string, params: UnknownRecord | undefined): void {
    const exchange = this.#active.get(key);
    if (exchange === undefined) return;
    this.#active.delete(key);
    exchange.endTimestamp = numberValue(params?.timestamp) ?? null;
    if (method === "Network.loadingFailed") {
      const error = cdpStringValue(params?.errorText) ?? "";
      exchange.error = /^net::ERR_[A-Z0-9_]{1,100}$/u.test(error)
        ? error
        : "net::ERR_FAILED";
      return;
    }
    if (!this.#bodySelected(exchange)) return;
    const decoded = Math.max(
      exchange.decodedBytes,
      numberValue(params?.encodedDataLength) ?? 0,
    );
    // Chrome sends non-ASCII body text as six-byte \uXXXX escapes; read only
    // a body whose worst-case reply fits one CDP message.
    if (decoded * 6 + 1024 > WEB_RUNTIME_LIMITS.protocolBytes) {
      this.context.completeness.exclude(
        "network_bodies",
        "resource_budget_exhausted",
      );
      exchange.body = {
        omitted: `Response body not read: its ${String(decoded)} bytes could exceed the ${String(WEB_RUNTIME_LIMITS.protocolBytes)} byte CDP message limit.`,
      };
      return;
    }
    // Reserve the base64 worst case before the browser sends its reply.
    const reserved = Math.ceil((decoded * 4) / 3) + 1024;
    if (reserved > this.#remainingBytes) {
      exchange.body = this.#budgetOmission("network_bodies");
      return;
    }
    this.#remainingBytes -= reserved;
    this.track(this.#readBody(exchange, reserved));
  }

  #bodySelected(exchange: RecordedExchange): boolean {
    const selection = this.context.options.response_bodies;
    return (
      selection === "all" ||
      (selection === "json" &&
        isJsonMediaType(cdpStringValue(exchange.response?.mimeType)))
    );
  }

  async #readBody(exchange: RecordedExchange, reserved: number): Promise<void> {
    const deadline = AbortSignal.timeout(BODY_READ_TIMEOUT_MS);
    const sessionId = exchange.target.sessionId;
    const sessionEnded =
      sessionId === undefined ? undefined : this.#sessionEnd(sessionId).signal;
    let reply: UnknownRecord | undefined;
    try {
      reply = recordValue(
        await this.context.connection.send(
          "Network.getResponseBody",
          { requestId: exchange.requestId },
          exchange.target.sessionId,
          AbortSignal.any([
            deadline,
            this.#abandonReads.signal,
            ...(sessionEnded === undefined ? [] : [sessionEnded]),
            ...(this.context.signal === undefined ? [] : [this.context.signal]),
          ]),
        ),
      );
    } catch (cause: unknown) {
      const omitted = this.#readOmission(cause, deadline, sessionEnded);
      if (omitted === undefined) throw cause;
      this.context.completeness.unavailable("network_bodies");
      exchange.body = { omitted };
      return;
    } finally {
      this.#remainingBytes += reserved;
    }
    const text = cdpStringValue(reply?.body);
    const base64 = reply?.base64Encoded === true;
    // Chrome reads back an empty body for a service worker's fetch whose
    // response the worker passes to a page, although its bytes arrived.
    if (text === "" && exchange.encodedBytes > 0) {
      this.context.completeness.unavailable("network_bodies");
      exchange.body = {
        omitted: `The browser exposed no body although ${String(exchange.encodedBytes)} encoded bytes arrived.`,
      };
    } else if (
      text !== undefined &&
      (!base64 || canonicalBase64Bytes(text) !== undefined)
    )
      exchange.body = this.#retain(text, base64);
    else {
      this.context.completeness.exclude(
        "network_bodies",
        "invalid_protocol_value",
      );
      exchange.body = { omitted: "CDP returned a malformed response body." };
    }
  }

  /**
   * Why a failed body read is an omission, or undefined when it must fail the
   * observation: caller cancellation, transport and other protocol failures.
   */
  #readOmission(
    cause: unknown,
    deadline: AbortSignal,
    sessionEnded: AbortSignal | undefined,
  ): string | undefined {
    if (this.context.signal?.aborted === true) return undefined;
    if (sessionEnded?.aborted === true)
      return "The worker ended before its response body was read.";
    // Set synchronously by a disconnect, before rejected reads are handled.
    if (this.#abandonReads.signal.aborted)
      return "The target ended before its response body was read.";
    if (deadline.aborted)
      return `The response body read did not finish within ${String(BODY_READ_TIMEOUT_MS / 1000)} s.`;
    if (!(cause instanceof CdpCommandRejection)) return undefined;
    if (cause.code === -32_601)
      return "Network.getResponseBody was unavailable from this browser target.";
    // The read's session no longer exists, as when a worker has exited.
    if (cause.code === -32_001)
      return "The target ended before its response body was read.";
    // The browser's "no body for this request" reply.
    return cause.code === -32_000 && cause.reportedMessage !== null
      ? `Response body unavailable: ${cause.reportedMessage}`
      : undefined;
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
    const retained = this.context.options.websocket_payloads
      ? this.#framePayload(payload, opcode)
      : undefined;
    socket.messages.push({
      type: method === "Network.webSocketFrameSent" ? "send" : "receive",
      time:
        socket.wallOffset !== null && timestamp !== undefined
          ? socket.wallOffset + timestamp
          : Date.now() / 1000,
      opcode,
      data: retained !== undefined && "text" in retained ? payload : null,
      bytes:
        opcode === 1
          ? Buffer.byteLength(payload)
          : (decodeBase64(payload)?.byteLength ?? null),
    });
  }

  /** Text frames are UTF-8; other frames carry base64 that must be canonical. */
  #framePayload(payload: string, opcode: number): RecordedContent {
    if (opcode === 1 || canonicalBase64Bytes(payload) !== undefined)
      return this.#retain(payload, opcode !== 1, "websocket_frames");
    this.context.completeness.exclude(
      "websocket_frames",
      "invalid_protocol_value",
    );
    return { omitted: "CDP returned malformed base64 frame data." };
  }

  #retain(
    text: string,
    base64: boolean,
    section: BudgetSection = "network_bodies",
  ): RecordedContent {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.#remainingBytes) return this.#budgetOmission(section);
    this.#remainingBytes -= bytes;
    return { text, base64 };
  }

  #budgetOmission(section: BudgetSection): RecordedContent {
    this.context.completeness.exclude(section, "resource_budget_exhausted");
    return {
      omitted: `Content omitted: the ${String(WEB_SESSION_NETWORK_CONTENT_BYTES)} byte retained-content budget was exhausted.`,
    };
  }
}

const openExchange = (
  target: SessionTarget,
  requestId: string,
  params: UnknownRecord | undefined,
  request: UnknownRecord,
  url: string,
): RecordedExchange => {
  const wallTime = numberValue(params?.wallTime);
  return {
    target,
    requestId,
    method: cdpStringValue(request.method) ?? "GET",
    url,
    resourceType: cdpStringValue(params?.type) ?? null,
    startedAtMs: wallTime === undefined ? null : wallTime * 1000,
    timestamp: numberValue(params?.timestamp) ?? null,
    requestHeaders: recordValue(request.headers),
    hasBody:
      request.hasPostData === true || typeof request.postData === "string",
    postData: undefined,
    response: undefined,
    responseTimestamp: null,
    redirectUrl: null,
    redirectExcluded: false,
    decodedBytes: 0,
    encodedBytes: 0,
    endTimestamp: null,
    error: null,
    body: undefined,
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

type BudgetSection = "network_bodies" | "websocket_frames";

/** Up to six bytes of escaped text plus base64 per body byte, with headroom. */
const INLINE_POST_DATA_BYTES = Math.floor(
  (WEB_RUNTIME_LIMITS.protocolBytes - 1024 * 1024) / 8,
);

/** Each body read is bounded like scenario network capture's reads. */
const BODY_READ_TIMEOUT_MS = 5_000;

const canonicalBase64Bytes = (text: string): Buffer | undefined => {
  const bytes = decodeBase64(text);
  return bytes?.toString("base64") === text ? bytes : undefined;
};

/** Fatal, so bytes that are not UTF-8 are not replaced; a BOM is kept. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
