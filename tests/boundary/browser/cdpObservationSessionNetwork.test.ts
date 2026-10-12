import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { decodeHarCapture } from "../../../src/browser/history/HarCapture.js";
import {
  observeWebSessionInputSchema,
  type WebObservationSession,
} from "../../../src/domain/browserSession.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

interface FakeEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}
type HarEntry = WebObservationSession["network"] extends infer N
  ? N extends { har: { log: { entries: (infer E)[] } } }
    ? E
    : never
  : never;

const PAGE_SESSION = "session-1";

interface NetworkScript {
  /** Events the page emits once REA enables its Network domain. */
  readonly page?: (
    origin: string,
    sessionId: string | undefined,
  ) => readonly FakeEvent[];
  readonly options?: FakeOptions;
}

/** A real CDP wire fake whose page session emits scripted traffic. */
const startNetworkBrowser = async (
  script: NetworkScript,
): Promise<FakeCdpBrowser> => {
  const browser = await startFakeCdpBrowser({
    ...script.options,
    commandEvents: (command, origin) => {
      if (command.method !== "Network.enable") return undefined;
      return command.sessionId === PAGE_SESSION ||
        command.sessionId === undefined
        ? (script.page?.(origin, command.sessionId) ?? [])
        : [];
    },
  });
  trackBrowser(browser);
  return browser;
};

const observe = async (
  browser: FakeCdpBrowser,
  input: Readonly<Record<string, unknown>> = {},
): Promise<WebObservationSession> => {
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 250,
      network: {},
      ...input,
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

let clock = 0;
const event = (
  method: string,
  sessionId: string | undefined,
  params: Readonly<Record<string, unknown>>,
): FakeEvent => ({
  method,
  ...(sessionId === undefined ? {} : { sessionId }),
  params,
});

const request = (
  sessionId: string | undefined,
  requestId: string,
  url: string,
  fields: {
    readonly event?: Readonly<Record<string, unknown>>;
    readonly request?: Readonly<Record<string, unknown>>;
  } = {},
): FakeEvent => {
  clock += 1;
  return event("Network.requestWillBeSent", sessionId, {
    requestId,
    type: "Fetch",
    wallTime: 1_800_000_000 + clock,
    timestamp: 100 + clock,
    request: { url, method: "GET", headers: {}, ...fields.request },
    ...fields.event,
  });
};

const response = (
  sessionId: string | undefined,
  requestId: string,
  mimeType: string,
  headers: Readonly<Record<string, string>> = {},
): FakeEvent =>
  event("Network.responseReceived", sessionId, {
    requestId,
    timestamp: 100 + clock + 0.25,
    response: {
      status: 200,
      statusText: "OK",
      mimeType,
      protocol: "h2",
      headers,
    },
  });

const finished = (
  sessionId: string | undefined,
  requestId: string,
  encodedDataLength = 16,
): FakeEvent =>
  event("Network.loadingFinished", sessionId, {
    requestId,
    timestamp: 100 + clock + 0.5,
    encodedDataLength,
  });

const exchange = (
  sessionId: string | undefined,
  requestId: string,
  url: string,
  mimeType = "application/json",
): FakeEvent[] => [
  request(sessionId, requestId, url),
  response(sessionId, requestId, mimeType),
  finished(sessionId, requestId),
];

const navigation = (sessionId: string | undefined, url: string): FakeEvent =>
  event("Page.frameNavigated", sessionId, {
    frame: {
      id: "frame-main",
      loaderId: `loader-${url}`,
      url,
      transitionType: "link",
    },
    timestamp: 100 + clock,
  });

/** Decodings a consumer applies, using WHATWG URL parsing as an independent oracle. */
const decodings = (value: string): string[] => {
  const decode = (text: string) =>
    new URLSearchParams(`v=${text.replaceAll("&", "%26")}`).get("v") ?? text;
  return [value, decode(value.replaceAll("+", "%2B")), decode(value)];
};

const entries = (session: WebObservationSession): HarEntry[] =>
  session.network?.har.log.entries ?? [];

const urlOf = (entry: HarEntry): string => {
  const requestValue = entry.request;
  if (
    typeof requestValue !== "object" ||
    requestValue === null ||
    Array.isArray(requestValue) ||
    typeof requestValue.url !== "string"
  )
    throw new Error("HAR entry has no request URL");
  return requestValue.url;
};

it("records traffic across a same-origin navigation as one admissible HAR", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => {
      const socketUrl = origin.replace("http:", "ws:");
      return [
        ...exchange(session, "first", `${origin}/a?step=1`),
        navigation(session, `${origin}/b`),
        ...exchange(session, "second", `${origin}/b/data`),
        event("Network.webSocketCreated", session, {
          requestId: "socket",
          url: `${socketUrl}/live`,
        }),
        event("Network.webSocketWillSendHandshakeRequest", session, {
          requestId: "socket",
          timestamp: 200,
          wallTime: 1_800_000_100,
          request: { headers: {} },
        }),
        event("Network.webSocketFrameSent", session, {
          requestId: "socket",
          timestamp: 200.5,
          response: { opcode: 1, mask: true, payloadData: "ping" },
        }),
        event("Network.webSocketFrameReceived", session, {
          requestId: "socket",
          timestamp: 201,
          response: { opcode: 1, mask: false, payloadData: "pong" },
        }),
      ];
    },
  });

  const session = await observe(browser);

  expect(session.window.end_reason).toBe("window_elapsed");
  expect(session.timeline).toContainEqual(
    expect.objectContaining({ url: `${browser.allowedOrigin}/b` }),
  );
  expect(entries(session).map(urlOf)).toEqual([
    `${browser.allowedOrigin}/a?step=1`,
    `${browser.allowedOrigin}/b/data`,
    `${browser.allowedOrigin.replace("http:", "ws:")}/live`,
  ]);
  expect(entries(session)[0]).toMatchObject({
    request: { httpVersion: "HTTP/2" },
    response: {
      status: 200,
      content: { mimeType: "application/json" },
    },
    _rea_target_id: "allowed-page",
  });
  expect(entries(session)[2]).toMatchObject({
    _resourceType: "websocket",
    _webSocketMessages: [
      { type: "send", opcode: 1, data: null, bytes: 4 },
      { type: "receive", opcode: 1, data: null, bytes: 4 },
    ],
  });
  expect(session.network).toMatchObject({
    prior_activity_available: false,
    targets: [{ target_id: "allowed-page", type: "page" }],
  });
  // Out-of-process iframes and workers are separate targets REA does not attach.
  expect(session.limitations).toEqual(
    expect.arrayContaining([
      "Network evidence covers selected-origin requests and WebSocket connections of the page's own target that start after REA attaches; frames on earlier sockets carry no URL and are excluded.",
      "Traffic of out-of-process (cross-site) iframes and of the page's workers (dedicated, shared and service workers), which the browser runs as separate targets, is not recorded, even when their origin is selected; a dedicated worker's script request can appear without its response.",
    ]),
  );
  const har = JSON.stringify(session.network?.har);
  expect(session.network?.har_bytes).toBe(Buffer.byteLength(har));
  // The emitted log is admissible to inspect_web_network_capture's decoder.
  expect(decodeHarCapture(har, []).records).toHaveLength(3);
});

it("replaces declared literals and query values everywhere and never keeps transport credentials", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      navigation(session, `${origin}/next?device_id=dev-123`),
      request(session, "post", `${origin}/api?device_id=dev-123&page=2`, {
        request: {
          method: "POST",
          headers: {
            Authorization: "Bearer request-token",
            Cookie: "sid=cookie-value",
            "X-Fingerprint": "FP456",
            "Content-Type": "application/json",
          },
          postData: '{"fp":"FP456","device":"dev-123"}',
        },
      }),
      response(session, "post", "application/json", {
        "Set-Cookie": "sid=cookie-value",
        "X-Echo": "dev-123",
      }),
      finished(session, "post"),
      event("Network.webSocketCreated", session, {
        requestId: "socket",
        url: `${origin.replace("http:", "ws:")}/live?device_id=dev-123`,
      }),
      event("Network.webSocketFrameSent", session, {
        requestId: "socket",
        timestamp: 300,
        response: { opcode: 1, payloadData: "hello FP456 dev-123" },
      }),
      event("Network.webSocketFrameReceived", session, {
        requestId: "socket",
        timestamp: 301,
        response: {
          opcode: 2,
          payloadData: Buffer.from("binary FP456").toString("base64"),
        },
      }),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_values: ["FP456"],
    sensitive_query_parameters: ["device_id"],
  });

  const serialized = JSON.stringify(session);
  for (const literal of [
    "FP456",
    "dev-123",
    "request-token",
    "cookie-value",
    Buffer.from("binary FP456").toString("base64"),
  ])
    expect(serialized).not.toContain(literal);
  const post = entries(session).find((entry) =>
    JSON.stringify(entry.request).includes('"method":"POST"'),
  );
  if (post === undefined) throw new Error("missing POST entry");
  const url = urlOf(post);
  // Percent-encoded markers keep each redacted URL a valid URI.
  expect(URL.canParse(url)).toBe(true);
  expect(new URL(url).searchParams.get("device_id")).toMatch(/REDACTED/u);
  expect(new URL(url).searchParams.get("page")).toBe("2");
  const headerNames = JSON.stringify(post).toLowerCase();
  expect(headerNames).not.toContain('"authorization"');
  expect(headerNames).not.toContain('"cookie"');
  expect(headerNames).not.toContain('"set-cookie"');
  expect(post).toMatchObject({
    request: { method: "POST", cookies: [] },
    response: { cookies: [] },
  });
  // Changed fields: the POST URL and its device_id query value, two header
  // values, and the socket URL and its query value.
  expect(session.network?.redactions).toEqual({
    transport_credential_headers: 3,
    out_of_scope_url_headers: 0,
    explicit_value_fields: 6,
  });
  expect(session.target.final_url).not.toContain("dev-123");
  expect(
    decodeHarCapture(JSON.stringify(session.network?.har), []).records,
  ).toHaveLength(2);
});

it("reads named query values from each retained URL source on its own", async () => {
  // Each value appears in exactly one retained URL, so no other source
  // declares it on that source's behalf.
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "page", `${origin}/page?code=REQURL1`, {
        request: { headers: { Referer: `${origin}/from?code=REQREF2` } },
      }),
      response(session, "page", "text/html", {
        Link: "</next?code=RESLINK3>; rel=next",
        "Content-Location": "/canon?code=RESLOC4",
      }),
      finished(session, "page"),
      event("Network.webSocketCreated", session, {
        requestId: "socket",
        url: `${origin.replace("http:", "ws:")}/live?code=WSURL5`,
      }),
      event("Network.webSocketWillSendHandshakeRequest", session, {
        requestId: "socket",
        timestamp: 900,
        wallTime: 1_900_000_000,
        request: { headers: { Referer: `${origin}/chat?code=WSREF6` } },
      }),
      event("Network.webSocketHandshakeResponseReceived", session, {
        requestId: "socket",
        timestamp: 900.25,
        response: {
          status: 101,
          statusText: "Switching Protocols",
          headers: { "Content-Location": `${origin}/socket?code=WSLOC7` },
        },
      }),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_query_parameters: ["code"],
  });

  for (const value of decodings(JSON.stringify(session)))
    for (const literal of [
      "REQURL1",
      "REQREF2",
      "RESLINK3",
      "RESLOC4",
      "WSURL5",
      "WSREF6",
      "WSLOC7",
    ])
      expect(value).not.toContain(literal);
  const origin = browser.allowedOrigin;
  const marker = (index: number) =>
    encodeURIComponent(`[REDACTED:value-${String(index)}]`);
  expect(entries(session)).toMatchObject([
    {
      request: {
        url: `${origin}/page?code=${marker(1)}`,
        headers: [
          { name: "Referer", value: `${origin}/from?code=${marker(2)}` },
        ],
      },
      response: {
        headers: [
          { name: "Link", value: "</next?code=[REDACTED:value-3]>; rel=next" },
          { name: "Content-Location", value: "/canon?code=[REDACTED:value-4]" },
        ],
      },
    },
    {
      request: {
        url: `${origin.replace("http:", "ws:")}/live?code=${marker(5)}`,
        headers: [
          { name: "Referer", value: `${origin}/chat?code=${marker(6)}` },
        ],
        queryString: [{ name: "code", value: "[REDACTED:value-5]" }],
      },
      response: {
        status: 101,
        headers: [
          {
            name: "Content-Location",
            value: `${origin}/socket?code=${marker(7)}`,
          },
        ],
      },
    },
  ]);
  expect(
    decodeHarCapture(JSON.stringify(session.network?.har), []).records,
  ).toHaveLength(2);
});

it("excludes out-of-scope requests, sockets and redirect targets with stated reasons", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      ...exchange(session, "foreign", "https://other.example.test/x"),
      request(session, "hop", `${origin}/start`),
      request(session, "hop", "https://other.example.test/landing?k=v", {
        event: { redirectResponse: { status: 302, headers: {} } },
      }),
      event("Network.webSocketCreated", session, {
        requestId: "foreign-socket",
        url: "wss://other.example.test/ws",
      }),
      event("Network.webSocketFrameReceived", session, {
        requestId: "foreign-socket",
        timestamp: 400,
        response: { opcode: 1, payloadData: "outside" },
      }),
      // A socket opened before attach has no creation event to authorize.
      event("Network.webSocketFrameReceived", session, {
        requestId: "earlier-socket",
        timestamp: 401,
        response: { opcode: 1, payloadData: "unattributed" },
      }),
    ],
  });

  const session = await observe(browser);

  expect(entries(session).map(urlOf)).toEqual([
    `${browser.allowedOrigin}/start`,
  ]);
  expect(entries(session)[0]).toMatchObject({
    response: { status: 302, redirectURL: "" },
    comment: expect.stringContaining("outside the selected origins"),
  });
  expect(JSON.stringify(session.network)).not.toContain("other.example.test");
  expect(session.completeness.excluded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        section: "network_requests",
        reason: "disallowed_origin",
        count: 2,
      }),
      expect.objectContaining({
        section: "websocket_connections",
        reason: "disallowed_origin",
      }),
      expect.objectContaining({
        section: "websocket_frames",
        reason: "disallowed_origin",
      }),
      expect.objectContaining({
        section: "websocket_frames",
        reason: "unattributed_origin",
      }),
    ]),
  );
});

it("stops recording at the moment the timeline leaves scope", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "form", `${origin}/form`, {
        request: { method: "POST", postData: "field=value" },
      }),
      ...exchange(session, "before", `${origin}/before`),
      navigation(session, "https://outside.example.test/"),
      ...exchange(session, "after", `${origin}/after`),
    ],
  });

  const session = await observe(browser);

  expect(session.window.end_reason).toBe("target_left_scope");
  expect(entries(session).map(urlOf)).toEqual([
    `${browser.allowedOrigin}/form`,
    `${browser.allowedOrigin}/before`,
  ]);
  // An unselected body is unknown (-1), not empty; a bodiless GET is 0.
  expect(entries(session).map((entry) => entry.request)).toEqual([
    expect.objectContaining({ method: "POST", bodySize: -1 }),
    expect.objectContaining({ method: "GET", bodySize: 0 }),
  ]);
  expect(JSON.stringify(session.network)).not.toContain("field=value");
});

it("keeps the in-scope document hop when its redirect leaves scope", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "login", `${origin}/login`, {
        event: { type: "Document", frameId: "frame-main", loaderId: "l1" },
      }),
      request(session, "login", "https://idp.example.test/authorize?x=1", {
        event: {
          type: "Document",
          frameId: "frame-main",
          loaderId: "l1",
          redirectResponse: { status: 302, statusText: "Found", headers: {} },
        },
      }),
    ],
  });

  const session = await observe(browser);

  expect(session.window.end_reason).toBe("target_left_scope");
  expect(entries(session)).toEqual([
    expect.objectContaining({
      response: expect.objectContaining({ status: 302, redirectURL: "" }),
      comment: expect.stringContaining("outside the selected origins"),
    }),
  ]);
  expect(session.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "network_requests",
      reason: "disallowed_origin",
    }),
  );
});

it("redacts declared values whatever their percent-encoding", async () => {
  const literals = ["tok/en*x", "O'Brien Smith", "a/b c", "x*y"];
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      // Lowercase hex, an unencoded '*' and a Referer repeating the value.
      ...exchange(session, "state", `${origin}/cb?state=tok%2fen*x`),
      request(session, "search", `${origin}/search?q=O%27Brien%20Smith`, {
        request: { headers: { Referer: `${origin}/cb?state=tok%2fen*x` } },
      }),
      request(session, "path", `${origin}/files/a%2Fb%20c/x#a%2Fb%20c`),
      request(session, "star", `${origin}/k?v=x%2Ay&keep=1`),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_values: ["O'Brien Smith", "a/b c", "x*y"],
    sensitive_query_parameters: ["state"],
  });

  for (const value of decodings(JSON.stringify(session)))
    for (const literal of literals) expect(value).not.toContain(literal);
  for (const entry of entries(session))
    expect(URL.canParse(urlOf(entry))).toBe(true);
  const star = entries(session).find((entry) => urlOf(entry).includes("/k?"));
  expect(star?.request).toMatchObject({
    queryString: [
      { name: "v", value: "[REDACTED:value-3]" },
      { name: "keep", value: "1" },
    ],
  });
  expect(
    entries(session).some((entry) =>
      JSON.stringify(entry.request).includes('"name":"Referer"'),
    ),
  ).toBe(true);
});

it("redacts declared values as written where decoding would erase their spelling", async () => {
  const literals = ["ab+/cd==", "tok+en", "abc%2fdef", "%7Euser", "tok%41"];
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      // Browsers keep a query's '+', '/', '=' and escapes as written.
      request(session, "sig", `${origin}/cb?sig=ab+/cd==&keep=a+b`, {
        request: { headers: { Referer: `${origin}/start?sig=ab+/cd==` } },
      }),
      request(session, "name", `${origin}/n?tok+en=1`),
      request(session, "lower", `${origin}/l?t=abc%2fdef`),
      request(session, "unreserved", `${origin}/%7Euser/k?v=tok%41&y=%41`),
      // Beside escapes, a written '+' leaves no spelling of the value to
      // replace once a form decodes it, so the value is emptied.
      request(session, "mixed", `${origin}/m?sig=ab+%2Fcd%3D%3D&x=1`),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_values: literals,
  });

  for (const value of decodings(JSON.stringify(session)))
    for (const literal of literals)
      for (const reading of decodings(literal))
        expect(value).not.toContain(reading);
  const origin = browser.allowedOrigin;
  const marker = (index: number) =>
    encodeURIComponent(`[REDACTED:value-${String(index)}]`);
  const query = (...pairs: (readonly [string, string])[]) =>
    pairs.map(([name, value]) => ({ name, value }));
  for (const entry of entries(session))
    expect(URL.canParse(urlOf(entry))).toBe(true);
  expect(entries(session).map((entry) => entry.request)).toMatchObject([
    {
      url: `${origin}/cb?sig=${marker(1)}&keep=a+b`,
      queryString: query(["sig", "[REDACTED:value-1]"], ["keep", "a b"]),
      headers: [{ name: "Referer", value: `${origin}/start?sig=${marker(1)}` }],
    },
    {
      url: `${origin}/n?${marker(2)}=1`,
      queryString: query(["[REDACTED:value-2]", "1"]),
    },
    {
      url: `${origin}/l?t=${marker(3)}`,
      queryString: query(["t", "[REDACTED:value-3]"]),
    },
    {
      url: `${origin}/${marker(4)}/k?v=${marker(5)}&y=%41`,
      queryString: query(["v", "[REDACTED:value-5]"], ["y", "A"]),
    },
    {
      url: `${origin}/m?sig=&x=1`,
      queryString: query(["sig", ""], ["x", "1"]),
    },
  ]);
  // Each URL and the query name or value it hides, and the Referer.
  expect(session.network?.redactions.explicit_value_fields).toBe(11);
});

it("redacts a redirect hop's status, header names, target and relative URL-valued headers", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "hop", `${origin}/start`),
      request(session, "hop", `${origin}/landing?code=SECRET1&state=1`, {
        event: {
          redirectResponse: {
            status: 302,
            statusText: "Found STATUSLIT",
            headers: {
              Location: "/landing?code=SECRET1&state=1",
              Link: "</next?code=SECRET1>; rel=next, </other>; rel=prev",
              Refresh: "0; url=/landing?code=SECRET1",
              // Only a decoded spelling of the declared "abc/def".
              "Content-Location": "/start?keep=1&v=abc%2fdef",
              "X-NAMELIT-Trace": "1",
            },
          },
        },
      }),
      response(session, "hop", "text/html"),
      finished(session, "hop"),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_values: ["STATUSLIT", "NAMELIT", "abc/def"],
    sensitive_query_parameters: ["code"],
  });

  for (const value of decodings(JSON.stringify(session)))
    for (const literal of ["SECRET1", "STATUSLIT", "NAMELIT", "abc/def"])
      expect(value).not.toContain(literal);
  const origin = browser.allowedOrigin;
  const target = `${origin}/landing?code=${encodeURIComponent("[REDACTED:value-4]")}&state=1`;
  // A URL-valued header that is not one absolute URL is redacted as text:
  // its markers are raw, and a value spelled only once decoded empties it.
  expect(entries(session)).toMatchObject([
    {
      request: { url: `${origin}/start` },
      response: {
        status: 302,
        statusText: "Found [REDACTED:value-1]",
        headers: [
          {
            name: "Location",
            value: "/landing?code=[REDACTED:value-4]&state=1",
          },
          {
            name: "Link",
            value:
              "</next?code=[REDACTED:value-4]>; rel=next, </other>; rel=prev",
          },
          { name: "Refresh", value: "0; url=/landing?code=[REDACTED:value-4]" },
          { name: "Content-Location", value: "" },
          { name: "X-[REDACTED:value-2]-Trace", value: "1" },
        ],
        redirectURL: target,
      },
    },
    { request: { url: target } },
  ]);
});

it("omits URL-valued headers that point outside the selected origins", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "go", `${origin}/go`, {
        request: {
          headers: {
            Referer: `${origin}/start?code=CODE456`,
            Origin: "https://idp.example.test",
          },
        },
      }),
      response(session, "go", "text/html", {
        Location: "https://idp.example.test/authorize?code=CODE123",
        Link: "<https://cdn.example.test/app.js>; rel=preload",
        Refresh: "0; url=https://sso.example.test/cb?code=CODE789",
        "Content-Location": "/go/canonical",
      }),
      finished(session, "go"),
      request(session, "away", `${origin}/away`, {
        request: { headers: { Referer: "https://elsewhere.example.test/" } },
      }),
      response(session, "away", "text/html", {
        Link: "https://bare.example.test/x; rel=preload",
        Location: `http://admin:hunter2@${origin.slice("http://".length)}/next`,
        "Content-Location": `http://user:token@${origin.slice("http://".length)}/c`,
      }),
      finished(session, "away"),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_query_parameters: ["code"],
  });

  const serialized = JSON.stringify(session.network);
  for (const leaked of [
    "idp.example.test",
    "cdn.example.test",
    "sso.example.test",
    "elsewhere.example.test",
    "bare.example.test",
    "CODE123",
    "CODE789",
    "CODE456",
    "hunter2",
    "token@",
  ])
    expect(serialized).not.toContain(leaked);
  // Origin, Location, Link, Refresh, the foreign Referer and the bare Link.
  expect(session.network?.redactions.out_of_scope_url_headers).toBe(6);
  // Userinfo removed from two retained URL-valued headers.
  expect(session.network?.redactions.transport_credential_headers).toBe(2);
  const [go, away] = entries(session);
  expect(go).toMatchObject({
    request: {
      headers: [
        {
          name: "Referer",
          value: `${browser.allowedOrigin}/start?code=%5BREDACTED%3Avalue-1%5D`,
        },
      ],
    },
    response: {
      headers: [{ name: "Content-Location", value: "/go/canonical" }],
    },
  });
  expect(away).toMatchObject({
    response: {
      headers: [
        { name: "Location", value: `${browser.allowedOrigin}/next` },
        { name: "Content-Location", value: `${browser.allowedOrigin}/c` },
      ],
    },
  });
});

it("removes userinfo and scopes Refresh in every URL-valued header spelling", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => {
      const host = origin.slice("http://".length);
      return [
        request(session, "rel", `${origin}/rel`),
        response(session, "rel", "text/html", {
          Location: `//admin:SCHEMEREL@${host}/next`,
          Link: `<//u:LINKPW@${host}/l>; rel=preload`,
          "Content-Location": `http://u:DOLLAR@${host}/a$&b`,
          Refresh: "5\n0; https://out.example.test/cb?code=BAREREFRESH\n0abc",
        }),
        finished(session, "rel"),
        request(session, "slash", `${origin}/slash`),
        response(session, "slash", "text/html", {
          Location: `http:\\\\u:BSLASH@${host}/x`,
          Refresh: `0 ${origin}/in`,
        }),
        finished(session, "slash"),
        request(session, "more", `${origin}/more`),
        response(session, "more", "text/html", {
          // WHATWG ends the authority at the `\\`, so only `u:RETARGET@` is
          // userinfo; cutting through the last @ would retarget the header.
          Location: `http://u:RETARGET@${host}\\x@evil.example.test/`,
          Link: `<${origin}/>; title="http://u:LINKDUP@${host}/", <http://u:LINKDUP@${host}/>; rel=next`,
          Refresh: ` 0 ;  URL = '  http://u:REFPW@${host}/r ' `,
        }),
        finished(session, "more"),
        request(session, "schemeonly", `${origin}/schemeonly`),
        response(session, "schemeonly", "text/html", {
          // Same-scheme spellings without "//" resolve as paths against the
          // request, but a standalone WHATWG parse reads credentials.
          Location: `http:u:SCHEMEONLY@${host}/a`,
          Link: `<http:/u:SCHEMELINK@${host}/b>; rel=next`,
        }),
        finished(session, "schemeonly"),
        request(session, "pair", `${origin}/pair`),
        response(session, "pair", "text/html", {
          // Cutting the earlier span first would shift the later one's offsets.
          Link: `<http://u:LINKA@${host}/a>; rel=a, <http://u:LINKB@${host}/b>; rel=b`,
        }),
        finished(session, "pair"),
      ];
    },
  });

  const session = await observe(browser, {
    network: { header_values: true },
  });

  const serialized = JSON.stringify(session.network);
  for (const leaked of [
    "SCHEMEREL",
    "LINKPW",
    "DOLLAR",
    "BSLASH",
    "RETARGET",
    "REFPW",
    "LINKA",
    "SCHEMEONLY",
    "SCHEMELINK",
    "LINKB",
    "out.example.test",
    "BAREREFRESH",
  ])
    expect(serialized).not.toContain(leaked);
  // The Refresh line without `url=` points outside the selected origin, and
  // a delay glued to text cannot be parsed.
  expect(session.network?.redactions.out_of_scope_url_headers).toBe(2);
  // Eight userinfo spans cut out, and three headers omitted because their
  // spellings (a backslash scheme, and same-scheme spellings without "//")
  // have no raw userinfo span the transport-URL parser can cut.
  expect(session.network?.redactions.transport_credential_headers).toBe(11);
  const host = browser.allowedOrigin.slice("http://".length);
  const [rel, slash, more, schemeonly, pair] = entries(session);
  expect(rel).toMatchObject({
    response: {
      headers: [
        { name: "Location", value: `//${host}/next` },
        { name: "Link", value: `<//${host}/l>; rel=preload` },
        { name: "Content-Location", value: `${browser.allowedOrigin}/a$&b` },
        { name: "Refresh", value: "5" },
      ],
    },
  });
  expect(slash).toMatchObject({
    response: {
      headers: [{ name: "Refresh", value: `0 ${browser.allowedOrigin}/in` }],
    },
  });
  // Only the parsed <target> is edited; the matching title text is not.
  expect(more).toMatchObject({
    response: {
      headers: [
        { name: "Location", value: `http://${host}\\x@evil.example.test/` },
        {
          name: "Link",
          value: `<${browser.allowedOrigin}/>; title="http://u:LINKDUP@${host}/", <http://${host}/>; rel=next`,
        },
        { name: "Refresh", value: ` 0 ;  URL = '  http://${host}/r ' ` },
      ],
    },
  });
  expect(schemeonly).toMatchObject({ response: { headers: [] } });
  expect(pair).toMatchObject({
    response: {
      headers: [
        {
          name: "Link",
          value: `<http://${host}/a>; rel=a, <http://${host}/b>; rel=b`,
        },
      ],
    },
  });
});

it("omits a quoted Refresh URL that Chromium reads to a later quote", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => {
      const host = origin.slice("http://".length);
      return [
        request(session, "quote", `${origin}/quote`),
        response(session, "quote", "text/html", {
          Refresh: [
            // Chromium ends a quoted URL at its last matching quote, so it
            // follows these to localhost, or keeps their userinfo, where the
            // first quote reads an in-scope target without one.
            `0; url="${origin}"@localhost:${new URL(origin).port}/cb?code=LASTQUOTE"`,
            `0; url='${origin}'@${host}/x'`,
            // With one closing quote, or none, both readings agree.
            `0; url="http://u:OPENPW@${host}/open`,
            `0; url="${origin}/single" 'x'`,
          ].join("\n"),
        }),
        finished(session, "quote"),
      ];
    },
  });

  const session = await observe(browser, {
    network: { header_values: true },
  });

  const serialized = JSON.stringify(session.network);
  for (const leaked of ["LASTQUOTE", "localhost", "/x'", "OPENPW"])
    expect(serialized).not.toContain(leaked);
  expect(session.network?.redactions).toStrictEqual({
    transport_credential_headers: 1,
    out_of_scope_url_headers: 2,
    explicit_value_fields: 0,
  });
  const host = browser.allowedOrigin.slice("http://".length);
  expect(entries(session)[0]).toMatchObject({
    response: {
      headers: [
        { name: "Refresh", value: `0; url="http://${host}/open` },
        {
          name: "Refresh",
          value: `0; url="${browser.allowedOrigin}/single" 'x'`,
        },
      ],
    },
  });
});

it("reads Link targets as RFC 8288 link-values and fails closed", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => {
      const host = origin.slice("http://".length);
      return [
        // A quoted `<` must not swallow the next target into a relative path.
        [
          "swallow",
          `<${origin}/>; title="a<b", <https://evil.example.test/x?code=SECRETQ>; rel=next`,
        ],
        [
          "hidden",
          `<${origin}/>; title="<", <http://u:PWLEAK@${host}/>; rel=next`,
        ],
        ["quoted", `<${origin}/>; title="\\"<", <http://u:QPAIR@${host}/q>`],
        ["open", `<${origin}/>, <https://evil2.example.test/x`],
        ["unclosed", `<${origin}/>; title="x, <https://evil3.example.test/>`],
        ["stray", `<${origin}/>; rel=next>`],
        ["strayopen", `<${origin}/>; rel=x <https://evil4.example.test/x`],
        // A URI-Reference holds no `<`, so a nested one cannot be a target.
        ["nested", `<${origin}/x<https://evil5.example.test/>; rel=next`],
        // An anchor names the link context, a URL like the target.
        [
          "anchored",
          `<http://u:TARGETPW@${host}/a>; rel=alternate; anchor="http://u:ANCHORPW@${host}/b"`,
        ],
        ["token", `<${origin}/a>; Anchor = #top; rel=x`],
        ["anchorout", `<${origin}/a>; anchor="https://evil6.example.test/b"`],
        [
          "anchorpair",
          `<${origin}/a>; anchor="https://evil7.example.test/\\"x"`,
        ],
        ["anchorbare", `<${origin}/a>; anchor=https://evil8.example.test/b`],
      ].flatMap(([id = "", link = ""]) => [
        request(session, id, `${origin}/${id}`),
        response(session, id, "text/html", { Link: link }),
        finished(session, id),
      ]);
    },
  });

  const session = await observe(browser, {
    network: { header_values: true },
  });

  const serialized = JSON.stringify(session.network);
  for (const leaked of [
    "evil",
    "SECRETQ",
    "PWLEAK",
    "QPAIR",
    "TARGETPW",
    "ANCHORPW",
  ])
    expect(serialized).not.toContain(leaked);
  // The out-of-scope target, the unterminated target and quoted-string, the
  // stray `>` and `<`, the nested target, the out-of-scope anchor, and the
  // anchors with a quoted-pair or a value that is not a token.
  expect(session.network?.redactions.out_of_scope_url_headers).toBe(9);
  expect(session.network?.redactions.transport_credential_headers).toBe(4);
  const origin = browser.allowedOrigin;
  const host = origin.slice("http://".length);
  const link = (value: string) => ({
    response: { headers: [{ name: "Link", value }] },
  });
  expect(entries(session)).toMatchObject([
    { response: { headers: [] } },
    link(`<${origin}/>; title="<", <http://${host}/>; rel=next`),
    link(`<${origin}/>; title="\\"<", <http://${host}/q>`),
    { response: { headers: [] } },
    { response: { headers: [] } },
    { response: { headers: [] } },
    { response: { headers: [] } },
    { response: { headers: [] } },
    link(`<http://${host}/a>; rel=alternate; anchor="http://${host}/b"`),
    link(`<${origin}/a>; Anchor = #top; rel=x`),
    { response: { headers: [] } },
    { response: { headers: [] } },
    { response: { headers: [] } },
  ]);
});

it("reads a Refresh delay glued to text without backtracking", async () => {
  // Overlapping digit quantifiers took tens of seconds on each such line, so
  // these four would outlast the test timeout.
  const glued = ["1".repeat(200_000) + "x", "2".repeat(200_000) + "y"].join(
    "\n",
  );
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "slow", `${origin}/slow`, {
        request: { headers: { Refresh: glued } },
      }),
      response(session, "slow", "text/html", { Refresh: glued }),
      finished(session, "slow"),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
  });

  // A delay glued to text cannot be parsed, so each line is omitted.
  expect(session.network?.redactions.out_of_scope_url_headers).toBe(4);
  expect(entries(session)).toMatchObject([
    { request: { headers: [] }, response: { headers: [] } },
  ]);
});

it("keeps the HAR admissible when a declared value spells every URL", async () => {
  const page = (origin: string, session: string | undefined) =>
    exchange(session, "cb", `${origin}/cb?proto=http&x=1`);
  const withSocket = (origin: string, session: string | undefined) => [
    ...page(origin, session),
    event("Network.webSocketCreated", session, {
      requestId: "socket",
      url: `${origin.replace("http:", "ws:")}/live`,
    }),
    event("Network.webSocketFrameSent", session, {
      requestId: "socket",
      timestamp: 300,
      response: { opcode: 1, payloadData: "ping" },
    }),
    event("Network.webSocketFrameReceived", session, {
      requestId: "socket",
      timestamp: 301,
      response: { opcode: 1, payloadData: "pong" },
    }),
  ];
  const omissions = (session: WebObservationSession) => ({
    unavailable: session.completeness.unavailable_sections,
    excluded: session.completeness.excluded.filter(
      ({ reason }) => reason === "provider_unavailable",
    ),
  });
  // The observed value "http" is spelled by the scheme and by the first
  // placeholder, so the next placeholder stands in for the URL.
  const scheme = await observe(await startNetworkBrowser({ page }), {
    sensitive_query_parameters: ["proto"],
  });
  expect(JSON.stringify(scheme.network?.har)).not.toContain("http:");
  expect(entries(scheme)).toMatchObject([{ request: { url: "urn:redacted" } }]);
  expect(
    decodeHarCapture(JSON.stringify(scheme.network?.har), []).records,
  ).toHaveLength(1);

  // Every URL spells ":", so both entries are omitted, each counted against
  // its own sections.
  const colon = await observe(await startNetworkBrowser({ page: withSocket }), {
    sensitive_values: [":"],
  });
  expect(entries(colon)).toEqual([]);
  expect(omissions(colon)).toEqual({
    unavailable: [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
    ],
    excluded: [
      { section: "network_requests", reason: "provider_unavailable", count: 1 },
      {
        section: "websocket_connections",
        reason: "provider_unavailable",
        count: 1,
      },
      { section: "websocket_frames", reason: "provider_unavailable", count: 2 },
    ],
  });
  expect(colon.limitations).toContainEqual(
    "2 HAR entries were omitted because every placeholder URL spells a declared sensitive value.",
  );
  expect(
    decodeHarCapture(JSON.stringify(colon.network?.har), []).records,
  ).toHaveLength(0);

  // Only the socket's URL spells a value that every placeholder spells, so
  // only the socket and its frames are omitted.
  const browser = await startNetworkBrowser({ page: withSocket });
  const socket = await observe(browser, {
    sensitive_values: ["ws", "urn", "x:y"],
  });
  expect(entries(socket).map(urlOf)).toEqual([
    `${browser.allowedOrigin}/cb?proto=http&x=1`,
  ]);
  expect(omissions(socket)).toEqual({
    unavailable: ["websocket_connections", "websocket_frames"],
    excluded: [
      {
        section: "websocket_connections",
        reason: "provider_unavailable",
        count: 1,
      },
      { section: "websocket_frames", reason: "provider_unavailable", count: 2 },
    ],
  });
});

it("emits browser-serialized URLs that the HAR decoder accepts", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) =>
      exchange(
        session,
        "query",
        `${origin}/api?filter[status]=active&q=a|b&c={x}&d=^`,
      ),
  });

  const session = await observe(browser);

  expect(urlOf(entries(session)[0] as HarEntry)).toContain("filter[status]");
  expect(
    decodeHarCapture(JSON.stringify(session.network?.har), []).records,
  ).toHaveLength(1);
});

it("emits URLs with a bare % or a query backslash that the HAR decoder accepts", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      // WHATWG serialization keeps both as the page wrote them.
      ...exchange(session, "percent", new URL("/search?q=100%", origin).href),
      ...exchange(session, "slash", new URL("/collect?e=a\\b", origin).href),
    ],
  });

  const session = await observe(browser);

  const origin = browser.allowedOrigin;
  expect(entries(session).map(urlOf)).toStrictEqual([
    `${origin}/search?q=100%`,
    `${origin}/collect?e=a\\b`,
  ]);
  expect(
    decodeHarCapture(JSON.stringify(session.network?.har), []).records,
  ).toHaveLength(2);
});

it("starts coverage once the browser has enabled network events", async () => {
  let enabledAt = Number.POSITIVE_INFINITY;
  const browser = await startNetworkBrowser({
    options: {
      commandResult: (command) => {
        if (
          command.method === "Network.enable" &&
          command.sessionId === PAGE_SESSION
        )
          enabledAt = Date.now();
        return undefined;
      },
    },
  });

  const session = await observe(browser);

  expect(
    Date.parse(session.network?.coverage_started_at ?? ""),
  ).toBeGreaterThanOrEqual(Math.floor(enabledAt));
});

it("reports HAR 1.2 timings for a response still loading", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "stream", `${origin}/events`),
      response(session, "stream", "text/event-stream"),
    ],
  });

  const session = await observe(browser);

  expect(entries(session)[0]).toMatchObject({
    time: 250,
    timings: { send: 0, wait: 250, receive: 0 },
    comment: expect.stringContaining("had not finished loading"),
  });
});

it("keeps a URL parseable when its host spells a declared value", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => exchange(session, "api", `${origin}/api?x=1`),
  });

  const session = await observe(browser, { sensitive_values: ["127.0.0.1"] });

  expect(JSON.stringify(session)).not.toContain("127.0.0.1");
  const [entry] = entries(session);
  if (entry === undefined) throw new Error("missing entry");
  // The port spells no declared value, so it is kept.
  expect(new URL(urlOf(entry)).host).toBe(
    `redacted.invalid:${new URL(browser.allowedOrigin).port}`,
  );
  expect(entry.request).toMatchObject({
    queryString: [{ name: "x", value: "1" }],
  });
  expect(session.limitations).toContainEqual(
    expect.stringContaining("left empty in the Evidence parameters"),
  );
});

it("keeps the host and an emptied port when only the port spells a declared value", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => exchange(session, "api", `${origin}/api?x=1`),
  });
  const { hostname, port } = new URL(browser.allowedOrigin);

  const session = await observe(browser, { sensitive_values: [port] });

  expect(JSON.stringify(session)).not.toContain(`:${port}`);
  // The ':' left before the emptied port marks the removed digits.
  expect(entries(session).map(urlOf)).toEqual([`http://${hostname}:/api?x=1`]);
  expect(
    decodeHarCapture(JSON.stringify(session.network?.har), []).records,
  ).toHaveLength(1);
});

it("leaves no query pairs when a declared value spans them", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "span", `${origin}/p?tok=SPANVAL&x=1`),
      response(session, "span", "text/plain"),
      finished(session, "span"),
    ],
  });

  const session = await observe(browser, {
    network: {},
    sensitive_values: ["tok=SPANVAL"],
  });

  // No single piece spells the value, so the URL fails closed, and the
  // pairs that would let a reader rebuild it fail closed with it.
  expect(JSON.stringify(session.network)).not.toContain("SPANVAL");
  const [entry] = entries(session);
  expect(entry?.request).toMatchObject({
    url: "http://redacted.invalid/",
    queryString: [],
  });
});

it("checks each derived query name and value as a field of its own", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) =>
      exchange(session, "q", `${origin}/q?x=a%2525252Fb&a%2525252Fb=2&k=1`),
  });

  const session = await observe(browser, { sensitive_values: ["a/b"] });

  // The URL spells "a/b" only four decodings deep and is kept; its decoded
  // query value and name spell it three deep and are emptied.
  const [entry] = entries(session);
  expect(entry?.request).toMatchObject({
    url: `${browser.allowedOrigin}/q?x=a%2525252Fb&a%2525252Fb=2&k=1`,
    queryString: [
      { name: "x", value: "" },
      { name: "", value: "2" },
      { name: "k", value: "1" },
    ],
  });
  expect(session.network?.redactions.explicit_value_fields).toBe(2);
});

it("keeps query pairs aligned when a redacted flag is emptied", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) =>
      exchange(session, "flag", `${origin}/flag?a=1&tok%2562&b=2&c=3`),
  });

  const session = await observe(browser, { sensitive_values: ["tokb"] });

  // Only the URL and the flag's name changed.
  const [entry] = entries(session);
  expect(entry?.request).toMatchObject({
    url: `${browser.allowedOrigin}/flag?a=1&=&b=2&c=3`,
    queryString: [
      { name: "a", value: "1" },
      { name: "", value: "" },
      { name: "b", value: "2" },
      { name: "c", value: "3" },
    ],
  });
  expect(session.network?.redactions.explicit_value_fields).toBe(2);
});

it("redacts declared values in browser metadata once for the result and HAR", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "ua", `${origin}/ua`, {
        request: { headers: { "User-Agent": "FakeChrome" } },
      }),
      response(session, "ua", "text/plain"),
      finished(session, "ua"),
    ],
  });

  const session = await observe(browser, {
    network: { header_values: true },
    sensitive_values: ["FakeChrome", "fake-revision", "1.3", "13.0"],
  });

  expect(JSON.stringify(session)).not.toMatch(/FakeChrome|fake-revision/u);
  expect(session.browser).toStrictEqual({
    product: "[REDACTED:value-1]/1.0",
    protocol_version: "[REDACTED:value-3]",
    revision: "[REDACTED:value-2]",
    user_agent: "[REDACTED:value-1]",
    js_version: "[REDACTED:value-4]",
  });
  expect(session.network?.har.log.browser).toEqual({
    name: session.browser.product,
    version: session.browser.revision,
  });
  // Browser metadata is redacted but not counted; the header value is.
  expect(session.network?.redactions.explicit_value_fields).toBe(1);
});

it("accepts a declared lone surrogate and redacts the pair it splits", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) =>
      exchange(session, "astral", `${origin}/p/%F0%90%80%80?q=1`),
  });

  const session = await observe(browser, {
    sensitive_values: ["\ud800", "ok"],
  });

  expect(entries(session)[0]?.request).toMatchObject({
    url: `${browser.allowedOrigin}/p/%5BREDACTED%3Avalue-1%5D%EF%BF%BD?q=1`,
  });
});

it("redacts declared values in metadata fields and target IDs consistently", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      request(session, "meta", `${origin}/meta`, {
        request: { method: "acme" },
      }),
      response(session, "meta", "application/vnd.acme+json"),
      finished(session, "meta"),
      event("Network.webSocketCreated", session, {
        requestId: "socket",
        url: `${origin.replace("http:", "ws:")}/live`,
      }),
    ],
  });

  const session = await observe(browser, {
    sensitive_values: ["acme", "allowed"],
  });

  const serialized = JSON.stringify(session);
  expect(serialized).not.toContain("acme");
  expect(serialized).not.toContain("allowed");
  expect(entries(session).map((entry) => entry._rea_target_id)).toEqual([
    session.target.target_id,
    session.target.target_id,
  ]);
  expect(session.network?.targets[0]?.target_id).toBe(session.target.target_id);
});

it("redacts query values and literals that only the navigation timeline retains", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => [
      navigation(session, `${origin}/reset?token=TOK123`),
      event("Network.requestWillBeSent", session, {
        requestId: "REQLIT-1",
        type: "Document",
        frameId: "frame-main",
        loaderId: "loader-hop",
        timestamp: 101,
        request: { url: `${origin}/done?token=TOK123`, headers: {} },
        redirectResponse: { status: 302, headers: {} },
      }),
      event("Page.lifecycleEvent", session, {
        frameId: "frame-main",
        loaderId: "loader-hop",
        name: "detaillit",
        timestamp: 102,
      }),
    ],
  });

  const session = await observe(browser, {
    network: undefined,
    sensitive_values: ["frame-main", "REQLIT", "detaillit"],
    sensitive_query_parameters: ["token"],
  });

  // Without network capture, the target and timeline URLs are the only
  // source of query values: the page's "frame-secret", then "TOK123".
  expect(session.network).toBeUndefined();
  for (const value of decodings(JSON.stringify(session)))
    for (const literal of [
      "frame-secret",
      "TOK123",
      "frame-main",
      "REQLIT",
      "detaillit",
    ])
      expect(value).not.toContain(literal);
  const origin = browser.allowedOrigin;
  const marker = (index: number) =>
    encodeURIComponent(`[REDACTED:value-${String(index)}]`);
  const frame = "[REDACTED:value-1]";
  expect(session.target).toMatchObject({
    initial_url: `${origin}/app?token=${marker(4)}`,
    final_url: `${origin}/app?token=${marker(4)}`,
  });
  expect(session.timeline).toMatchObject([
    {
      type: "navigation_committed",
      frame_id: frame,
      url: `${origin}/reset?token=${marker(5)}`,
      detail: "link",
    },
    {
      type: "redirect",
      frame_id: frame,
      request_id: "[REDACTED:value-2]-1",
      url: `${origin}/done?token=${marker(5)}`,
    },
    { type: "lifecycle", frame_id: frame, detail: "[REDACTED:value-3]" },
  ]);
});

it("keeps navigation-only sessions unchanged when network is not selected", async () => {
  const browser = await startNetworkBrowser({
    page: (origin, session) => exchange(session, "ignored", `${origin}/x`),
  });

  const session = await observe(browser, { network: undefined });

  expect(session.network).toBeUndefined();
  expect(session.limitations).toContain(
    "Only navigation metadata is retained because network was not selected; no requests, headers, bodies, cookies, console values, or payloads were captured.",
  );
  expect(
    browser.commands.some(({ method }) => method.startsWith("Target.set")),
  ).toBe(false);
});
