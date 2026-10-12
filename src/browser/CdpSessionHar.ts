import { parseRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import type {
  ObserveWebSessionInput,
  WebSessionNetwork,
} from "../domain/browserSession.js";
import {
  cdpStringValue,
  numberValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import {
  headerUrlTargets,
  type CdpSessionNetwork,
  type RecordedExchange,
  type RecordedSocket,
} from "./CdpSessionNetwork.js";
import { TRANSPORT_CREDENTIAL_HEADERS } from "./network/TransportCredentials.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "./providerIdentities.js";

type HarObject = WebSessionNetwork["har"]["log"]["entries"][number];

/** Limitations stated whenever observe_web_session records network evidence. */
export const SESSION_NETWORK_LIMITATIONS = [
  "Network evidence covers selected-origin requests and WebSocket connections of the page's own target that start after REA attaches; frames on earlier sockets carry no URL and are excluded.",
  "Traffic of out-of-process (cross-site) iframes and of the page's workers (dedicated, shared and service workers), which the browser runs as separate targets, is not recorded, even when their origin is selected; a dedicated worker's script request can appear without its response.",
  "Authorization, Proxy-Authorization, Cookie and Set-Cookie headers are never retained, and HAR cookie arrays are empty. Headers are those CDP reports on request and response events.",
  "Request and response bodies and WebSocket payloads are not retained; sizes are reported where CDP provides them.",
];

interface HarContext {
  readonly options: NonNullable<ObserveWebSessionInput["network"]>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly coverageStartedAtMs: number;
  credentialHeaders: number;
  outOfScopeUrlHeaders: number;
}

/** Project recorded traffic into HAR 1.2 evidence and report its size. */
export const sessionNetworkEvidence = (input: {
  readonly network: CdpSessionNetwork;
  readonly browser: { readonly product: string; readonly revision: string };
  readonly coverageStartedAt: Date;
}): WebSessionNetwork => {
  const { network } = input;
  const context: HarContext = {
    options: network.context.options,
    allowedOrigins: network.context.allowedOrigins,
    coverageStartedAtMs: input.coverageStartedAt.getTime(),
    credentialHeaders: 0,
    outOfScopeUrlHeaders: 0,
  };
  const entries = [
    ...network.exchanges.map((exchange) => exchangeEntry(context, exchange)),
    ...network.sockets.map((socket) => socketEntry(context, socket)),
  ].sort((left, right) => left.started - right.started);
  const har: WebSessionNetwork["har"] = {
    log: {
      version: "1.2",
      creator: {
        name: CDP_BROWSER_PROVIDER_IDENTITY.name,
        version: CDP_BROWSER_PROVIDER_IDENTITY.version ?? "unknown",
      },
      browser: { name: input.browser.product, version: input.browser.revision },
      entries: entries.map(({ entry }) => entry),
    },
  };
  const harBytes = Buffer.byteLength(JSON.stringify(har));
  return {
    har,
    har_bytes: harBytes,
    targets: network.targets.map(
      ({ sessionId: _sessionId, ...target }) => target,
    ),
    redactions: {
      transport_credential_headers: context.credentialHeaders,
      out_of_scope_url_headers: context.outOfScopeUrlHeaders,
    },
    coverage_started_at: input.coverageStartedAt.toISOString(),
    prior_activity_available: false,
  };
};

const exchangeEntry = (
  context: HarContext,
  exchange: RecordedExchange,
): { readonly started: number; readonly entry: HarObject } => {
  const response = exchange.response;
  const httpVersion = harHttpVersion(cdpStringValue(response?.protocol));
  const started = exchange.startedAtMs ?? context.coverageStartedAtMs;
  // HAR 1.2: send, wait and receive are non-negative and time is their sum.
  // An unobserved phase is 0 and the entry comment says why.
  const timings = {
    send: 0,
    wait: elapsed(exchange.timestamp, exchange.responseTimestamp) ?? 0,
    receive: elapsed(exchange.responseTimestamp, exchange.endTimestamp) ?? 0,
  };
  const comment = [
    response === undefined && exchange.error === null
      ? "No response was observed on this target before the observation window ended."
      : undefined,
    response !== undefined &&
    exchange.endTimestamp === null &&
    exchange.error === null
      ? "The response had not finished loading when recording stopped."
      : undefined,
    exchange.redirectExcluded
      ? "The redirect target was outside the selected origins and is not retained."
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return {
    started,
    entry: {
      startedDateTime: new Date(started).toISOString(),
      time: timings.send + timings.wait + timings.receive,
      request: {
        ...harRequest(
          context,
          exchange.method,
          exchange.url,
          exchange.requestHeaders,
        ),
        httpVersion,
        // HAR uses -1 for a body whose size was not retained.
        bodySize: exchange.hasBody ? -1 : 0,
      },
      response: {
        ...harResponse(context, response, httpVersion, exchange.url),
        content: {
          size: exchange.decodedBytes,
          mimeType: cdpStringValue(response?.mimeType) ?? "",
        },
        redirectURL: exchange.redirectUrl ?? "",
      },
      cache: {},
      timings,
      ...(exchange.error === null ? {} : { _error: exchange.error }),
      _resourceType: (exchange.resourceType ?? "other").toLowerCase(),
      _rea_target_id: exchange.target.target_id,
      ...(comment === "" ? {} : { comment }),
    },
  };
};

const socketEntry = (
  context: HarContext,
  socket: RecordedSocket,
): { readonly started: number; readonly entry: HarObject } => ({
  started: socket.startedAtMs,
  entry: {
    startedDateTime: new Date(socket.startedAtMs).toISOString(),
    time: 0,
    request: {
      ...harRequest(context, "GET", socket.url, socket.requestHeaders),
      httpVersion: "HTTP/1.1",
      bodySize: 0,
    },
    response: {
      ...harResponse(context, socket.response, "HTTP/1.1", socket.url),
      content: { size: 0, mimeType: "" },
      redirectURL: "",
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: "websocket",
    _rea_target_id: socket.target.target_id,
    _webSocketMessages: socket.messages.map((message) => ({
      ...message,
      data: null,
    })),
  },
});

const harRequest = (
  context: HarContext,
  method: string,
  rawUrl: string,
  headers: UnknownRecord | undefined,
) => ({
  method,
  url: rawUrl,
  cookies: [],
  headers: harHeaders(context, headers, rawUrl),
  queryString: URL.canParse(rawUrl)
    ? [...new URL(rawUrl).searchParams].map(([name, value]) => ({
        name,
        value,
      }))
    : [],
  headersSize: -1,
});

const harResponse = (
  context: HarContext,
  response: UnknownRecord | undefined,
  httpVersion: string,
  requestUrl: string,
) => ({
  status: Math.trunc(numberValue(response?.status) ?? 0),
  statusText: cdpStringValue(response?.statusText) ?? "",
  httpVersion,
  cookies: [],
  headers: harHeaders(context, recordValue(response?.headers), requestUrl),
  headersSize: -1,
  bodySize: -1,
});

const harHeaders = (
  context: HarContext,
  record: UnknownRecord | undefined,
  requestUrl: string,
): HarObject[] => {
  if (!context.options.header_values || record === undefined) return [];
  return Object.entries(record).flatMap(([name, value]) => {
    if (typeof value !== "string") return [];
    if (TRANSPORT_CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      context.credentialHeaders += 1;
      return [];
    }
    // CDP joins repeated header lines with newlines.
    return value.split("\n").flatMap((line) => {
      const header = headerValue(context, name, line, requestUrl);
      return header === undefined ? [] : [{ name, value: header }];
    });
  });
};

/** URL-valued headers follow the request scope; out-of-scope ones are omitted. */
const headerValue = (
  context: HarContext,
  name: string,
  line: string,
  requestUrl: string,
): string | undefined => {
  const targets = headerUrlTargets(name, line, requestUrl);
  if (targets === undefined) return line;
  // A URL-valued header without a scopable target cannot be authorized.
  if (
    targets.length === 0 ||
    !targets.every(({ url }) => inScope(url, context.allowedOrigins))
  ) {
    context.outOfScopeUrlHeaders += 1;
    return undefined;
  }
  // URL userinfo is a transport credential, judged on the resolved target. A
  // cut that would not leave the same target, or a spelling with no raw
  // userinfo span (recordedTransportUrl reads it as ambiguous), omits
  // the header; cuts are spliced at parsed offsets, last first.
  let value = line;
  for (const { raw, start, url } of [...targets].sort(
    (left, right) => right.start - left.start,
  )) {
    const { credentials } = parseRecordedTransportUrl(raw);
    if (!hasUserInfo(url) && credentials !== "ambiguous") continue;
    context.credentialHeaders += 1;
    if (credentials === null || credentials === "ambiguous") return undefined;
    const stripped =
      raw.slice(0, credentials.start) + raw.slice(credentials.end);
    if (resolveUrl(stripped, requestUrl) !== withoutCredentials(url))
      return undefined;
    value = value.slice(0, start) + stripped + value.slice(start + raw.length);
  }
  return value;
};

const resolveUrl = (raw: string, base: string): string =>
  URL.canParse(raw, base) ? new URL(raw, base).href : raw;

const withoutCredentials = (url: string): string =>
  Object.assign(new URL(url), { username: "", password: "" }).href;

const hasUserInfo = (url: string): boolean =>
  URL.canParse(url) && withoutCredentials(url) !== new URL(url).href;

const inScope = (url: string, allowedOrigins: ReadonlySet<string>): boolean => {
  if (!URL.canParse(url)) return false;
  const origin = new URL(url).origin;
  return origin !== "null" && allowedOrigins.has(origin);
};

const HTTP_VERSIONS = new Map([
  ["http/1.0", "HTTP/1.0"],
  ["http/1.1", "HTTP/1.1"],
  ["h2", "HTTP/2"],
  ["h3", "HTTP/3"],
]);

const harHttpVersion = (protocol: string | undefined): string =>
  HTTP_VERSIONS.get(protocol?.toLowerCase() ?? "") ?? protocol ?? "";

/** Milliseconds between monotonic CDP seconds, or null when unobserved. */
const elapsed = (start: number | null, end: number | null): number | null =>
  start !== null && end !== null && end >= start ? (end - start) * 1000 : null;
