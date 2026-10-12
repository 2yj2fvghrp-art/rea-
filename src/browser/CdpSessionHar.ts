import { parseRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import {
  WEB_SESSION_NETWORK_CONTENT_BYTES,
  type ObserveWebSessionInput,
  type WebSessionNetwork,
} from "../domain/browserSession.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../domain/webNetworkCapture.js";
import {
  cdpStringValue,
  numberValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import {
  headerUrlTargets,
  type CdpSessionNetwork,
  type RecordedContent,
  type RecordedExchange,
  type RecordedSocket,
} from "./CdpSessionNetwork.js";
import { TRANSPORT_CREDENTIAL_HEADERS } from "./network/TransportCredentials.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "./providerIdentities.js";
import type { SessionRedactor } from "./SessionRedactor.js";

type HarObject = WebSessionNetwork["har"]["log"]["entries"][number];

/** A HAR entry by start time; a WebSocket's also counts its frames. */
interface SessionEntry {
  readonly started: number;
  readonly entry: HarObject;
  readonly frames?: number;
  /** Bodies or frame payloads withheld because redaction emptied them. */
  readonly withheld: number;
}

/** Limitations stated whenever observe_web_session records network evidence. */
export const SESSION_NETWORK_LIMITATIONS = [
  "Network evidence covers selected-origin requests and WebSocket connections of the page's own target that start after REA attaches; frames on earlier sockets carry no URL and are excluded.",
  "Traffic of out-of-process (cross-site) iframes and of the page's workers (dedicated, shared and service workers), which the browser runs as separate targets, is not recorded, even when their origin is selected; a dedicated worker's script request can appear without its response.",
  "Authorization, Proxy-Authorization, Cookie and Set-Cookie headers are never retained, and HAR cookie arrays are empty. Headers are those CDP reports on request and response events.",
  "Bodies are browser-decoded. Response bodies are read after loading finishes and can be unavailable once the browser releases them; each omission is stated in its entry comment.",
  `Retained bodies and WebSocket payloads share a ${String(WEB_SESSION_NETWORK_CONTENT_BYTES)} byte budget, equal to inspect_web_network_capture's input budget; request and frame metadata are not capped.`,
];

interface HarContext {
  readonly options: NonNullable<ObserveWebSessionInput["network"]>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly redactor: SessionRedactor;
  readonly coverageStartedAtMs: number;
  credentialHeaders: number;
  outOfScopeUrlHeaders: number;
}

/** Project recorded traffic into redacted HAR 1.2 evidence and report its size. */
export const sessionNetworkEvidence = (input: {
  readonly network: CdpSessionNetwork;
  readonly browser: { readonly product: string; readonly revision: string };
  readonly coverageStartedAt: Date;
  readonly redactor: SessionRedactor;
}): WebSessionNetwork => {
  const { network, redactor } = input;
  const redactedBefore = redactor.fields;
  const context: HarContext = {
    options: network.context.options,
    allowedOrigins: network.context.allowedOrigins,
    redactor,
    coverageStartedAtMs: input.coverageStartedAt.getTime(),
    credentialHeaders: 0,
    outOfScopeUrlHeaders: 0,
  };
  const entries = [
    ...network.exchanges.map((exchange) => exchangeEntry(context, exchange)),
    ...network.sockets.map((socket) => socketEntry(context, socket)),
  ].sort((left, right) => left.started - right.started);
  // A request URL redaction emptied cannot form an admissible HAR entry.
  const admissible: SessionEntry[] = [];
  const omitted: SessionEntry[] = [];
  for (const item of entries) {
    const url = cdpStringValue(recordValue(item.entry.request)?.url) ?? "";
    (URL.canParse(url) ? admissible : omitted).push(item);
  }
  const sockets = omitted.filter(({ frames }) => frames !== undefined);
  // Withheld content counts only where its entry is retained.
  const withheld = { network_bodies: 0, websocket_frames: 0 };
  for (const { frames, withheld: count } of admissible)
    withheld[frames === undefined ? "network_bodies" : "websocket_frames"] +=
      count;
  for (const [section, count] of [
    ["network_requests", omitted.length - sockets.length],
    ["websocket_connections", sockets.length],
    [
      "websocket_frames",
      sockets.reduce((sum, { frames = 0 }) => sum + frames, 0),
    ],
    ["network_bodies", withheld.network_bodies],
    ["websocket_frames", withheld.websocket_frames],
  ] as const)
    if (count > 0)
      network.context.completeness.exclude(
        section,
        "provider_unavailable",
        count,
      );
  if (omitted.length > 0)
    network.context.limitations.push(
      `${String(omitted.length)} HAR entries were omitted because every placeholder URL spells a declared sensitive value.`,
    );
  if (withheld.websocket_frames > 0)
    network.context.limitations.push(
      `${String(withheld.websocket_frames)} WebSocket payloads have data null because redacting declared sensitive values emptied them.`,
    );
  const har: WebSessionNetwork["har"] = {
    log: {
      version: "1.2",
      creator: {
        name: CDP_BROWSER_PROVIDER_IDENTITY.name,
        version: CDP_BROWSER_PROVIDER_IDENTITY.version ?? "unknown",
      },
      browser: { name: input.browser.product, version: input.browser.revision },
      entries: admissible.map(({ entry }) => entry),
    },
  };
  const harBytes = Buffer.byteLength(JSON.stringify(har));
  if (harBytes > WEB_NETWORK_CAPTURE_LIMITS.inputBytes)
    network.context.limitations.push(
      `The ${String(harBytes)} byte HAR exceeds inspect_web_network_capture's ${String(WEB_NETWORK_CAPTURE_LIMITS.inputBytes)} byte input budget; select fewer origins, bodies or WebSocket payloads, drop header values, or use a shorter window.`,
    );
  return {
    har,
    har_bytes: harBytes,
    content_budget_bytes: WEB_SESSION_NETWORK_CONTENT_BYTES,
    retained_content_bytes: network.retainedContentBytes,
    targets: network.targets.map(({ sessionId: _sessionId, ...target }) => ({
      ...target,
      target_id: redactor.text(target.target_id),
      url: target.url === null ? null : redactor.url(target.url),
    })),
    redactions: {
      transport_credential_headers: context.credentialHeaders,
      out_of_scope_url_headers: context.outOfScopeUrlHeaders,
      explicit_value_fields: redactor.fields - redactedBefore,
    },
    coverage_started_at: input.coverageStartedAt.toISOString(),
    prior_activity_available: false,
  };
};

const exchangeEntry = (
  context: HarContext,
  exchange: RecordedExchange,
): SessionEntry => {
  const { redactor } = context;
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
  const postData = redacted(redactor, exchange.postData);
  const body = redacted(redactor, exchange.body);
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
    postData === null
      ? "Request body withheld: redacting declared sensitive values emptied it."
      : omission(postData),
    body === null
      ? "Response body withheld: redacting declared sensitive values emptied it."
      : omission(body),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return {
    started,
    withheld: Number(postData === null) + Number(body === null),
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
        ...harPostData(context, exchange, postData),
      },
      response: {
        ...harResponse(context, response, httpVersion, exchange.url),
        content: {
          size: exchange.decodedBytes,
          mimeType: redactor.text(cdpStringValue(response?.mimeType) ?? ""),
          ...harContent(body),
        },
        redirectURL:
          exchange.redirectUrl === null
            ? ""
            : redactor.url(exchange.redirectUrl),
      },
      cache: {},
      timings,
      ...(exchange.error === null ? {} : { _error: exchange.error }),
      _resourceType: redactor.text(
        (exchange.resourceType ?? "other").toLowerCase(),
      ),
      _rea_target_id: redactor.text(exchange.target.target_id),
      // Omission reasons can quote the browser's error text.
      ...(comment === "" ? {} : { comment: context.redactor.text(comment) }),
    },
  };
};

const socketEntry = (
  context: HarContext,
  socket: RecordedSocket,
): SessionEntry => {
  // A payload redaction empties has no data, like one beyond the budget.
  let withheld = 0;
  const messages = socket.messages.map((message) => {
    const data =
      message.data === null
        ? null
        : redactedText(context.redactor, message.data, message.opcode !== 1);
    if (data === null && message.data !== null) withheld += 1;
    return { ...message, data };
  });
  return {
    started: socket.startedAtMs,
    frames: messages.length,
    withheld,
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
      _rea_target_id: context.redactor.text(socket.target.target_id),
      _webSocketMessages: messages,
    },
  };
};

const harRequest = (
  context: HarContext,
  method: string,
  rawUrl: string,
  headers: UnknownRecord | undefined,
) => {
  const url = context.redactor.url(rawUrl);
  return {
    method: context.redactor.text(method),
    url,
    cookies: [],
    headers: harHeaders(context, headers, rawUrl),
    queryString: harQueryString(context, rawUrl, url),
    headersSize: -1,
  };
};

/**
 * The recorded URL's query pairs, so they never reveal what it hides: a
 * declared value spanning `=` or `&` fails the URL closed and leaves no pairs.
 * Each name or value that differs from the request's own counts as redacted.
 * A decoded pair is one level closer to a nested literal, so each name and
 * value is then redacted as a field of its own.
 */
const harQueryString = (
  context: HarContext,
  rawUrl: string,
  url: string,
): Array<{ name: string; value: string }> => {
  const pairs = URL.canParse(url) ? [...new URL(url).searchParams] : [];
  const original = URL.canParse(rawUrl)
    ? [...new URL(rawUrl).searchParams]
    : [];
  original.forEach(([name, value], index) => {
    const [redactedName, redactedValue] = pairs[index] ?? [];
    if (name !== "" && name !== redactedName) context.redactor.fields += 1;
    if (value !== "" && value !== redactedValue) context.redactor.fields += 1;
  });
  return pairs.map(([name, value]) => ({
    name: context.redactor.text(name),
    value: context.redactor.text(value),
  }));
};

const harResponse = (
  context: HarContext,
  response: UnknownRecord | undefined,
  httpVersion: string,
  requestUrl: string,
) => ({
  status: Math.trunc(numberValue(response?.status) ?? 0),
  statusText: context.redactor.text(cdpStringValue(response?.statusText) ?? ""),
  httpVersion,
  cookies: [],
  headers: harHeaders(context, recordValue(response?.headers), requestUrl),
  headersSize: -1,
  bodySize: -1,
});

/** HAR postData from the redacted body; its size is the body's as sent. */
const harPostData = (
  context: HarContext,
  exchange: RecordedExchange,
  postData: RecordedContent | null | undefined,
) => {
  const sent = exchange.postData;
  // HAR uses -1 for a body whose size was not retained.
  if (sent === undefined) return { bodySize: exchange.hasBody ? -1 : 0 };
  if (!("text" in sent)) return { bodySize: sent.bytes ?? -1 };
  const bodySize = Buffer.byteLength(sent.text);
  // A withheld body keeps the size it was sent with.
  if (postData === null || postData === undefined || !("text" in postData))
    return { bodySize };
  const contentType = Object.entries(exchange.requestHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return {
    bodySize,
    postData: {
      mimeType:
        typeof contentType === "string"
          ? context.redactor.text(contentType)
          : "",
      text: postData.text,
    },
  };
};

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
      return header === undefined
        ? []
        : [{ name: context.redactor.text(name), value: header }];
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
  if (targets === undefined) return context.redactor.text(line);
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
  return URL.canParse(value) && targets.length === 1
    ? context.redactor.url(value)
    : context.redactor.text(value);
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

/**
 * Redacted text or base64, or null when redaction emptied it: such content is
 * withheld, since empty text would read as empty content.
 */
const redactedText = (
  redactor: SessionRedactor,
  text: string,
  base64: boolean,
): string | null => {
  const replaced = base64 ? redactor.base64(text) : redactor.text(text);
  return replaced === "" && text !== "" ? null : replaced;
};

/** Retained content with its text redacted, or null when withheld. */
const redacted = (
  redactor: SessionRedactor,
  content: RecordedContent | undefined,
): RecordedContent | null | undefined => {
  if (content === undefined || !("text" in content)) return content;
  const text = redactedText(redactor, content.text, content.base64);
  return text === null ? null : { text, base64: content.base64 };
};

const harContent = (body: RecordedContent | null | undefined) =>
  body === null || body === undefined || !("text" in body)
    ? {}
    : body.base64
      ? { text: body.text, encoding: "base64" }
      : { text: body.text };

const omission = (content: RecordedContent | undefined): string | undefined =>
  content !== undefined && "omitted" in content ? content.omitted : undefined;

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
