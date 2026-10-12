# Website observation with CDP

Captured Debugger sources can be exported for REA's existing static JavaScript
analysis with `export_web_scripts`. See [captured website scripts](website-script-export.md)
for the capture options, source mappings, and browser/local resolution limits.
Use [captured module relationships](website-module-trace.md) to resolve one
exported script's native imports under an explicit URL/import-map context.

REA can attach to a user-owned Chrome-family browser through the Chrome DevTools Protocol (CDP) and produce bounded Evidence about an existing page. This is a passive reverse-engineering capability, not a general browser automation or remote-control surface.

## Shipped surfaces

- `list_browser_targets` / `rea list-browser-targets` discovers all eligible page targets at the endpoint by default, with an optional exact-origin filter.
- `inspect_web_page` / `rea inspect-web-page` captures DOM structure, accessibility nodes, scripts, resources, safe response/DOM metadata, attach-window network and console metadata, WebSocket frame sizes, workers, quota, and optionally selected storage key names, redacted storage-content fingerprints, or script sources.
- `analyze_web_bundle` / `rea analyze-web-bundle` parses selected script artifacts without execution and derives chunk edges, route and endpoint candidates, vendor fingerprints, static WebMCP declarations, and optionally source-map/original-source evidence.
- `observe_web_session` / `rea observe-web-session` arms an observation window of the requested duration for an external user action and records ordered reload, SPA navigation, redirect, failure, lifecycle, and target-termination metadata. When selected, it also [records the session's in-scope traffic as HAR](#record-session-traffic-as-har).
- `discover_webmcp_tools` / `rea discover-webmcp-tools` uses the experimental CDP WebMCP domain to return every in-scope registration and its complete observed `input_schema` declaration and canonical `input_schema_sha256` digest inline. Declarations are untrusted JSON data, including declared types, required fields, enums, examples and reference URLs. REA does not resolve schema references. These fields replace `input_schema_shape`. Registrations with the same name and URL in distinct observed frames retain separate identities. `tool_key` includes the observed frame ID; it is not a stable identity across navigation or browser sessions. Same-frame registration updates replace that owner only, and removal leaves other owners intact. REA never exposes `WebMCP.invokeTool`; malformed protocol payloads fail explicitly instead of returning incomplete tool metadata.
- `compare_web_captures` / `rea compare-web-captures` compares passive captures or exact-step-aligned browser scenarios. Scenario results commit reproducible literal normalization and expose alignment failures plus artifact-level action, screenshot, DOM, accessibility, URL, history, storage, and event differences. Missing or truncated evidence is never treated as equivalence.
- `capture_web_screenshot` / `rea capture-web-screenshot` returns a content-addressed visible-viewport PNG.
- `compare_web_screenshots` / `rea compare-web-screenshots` performs bounded local PNG pixel comparison without OCR or external services.
- The CLI comparison commands accept each capture, screenshot artifact or normalization policy as inline JSON or a JSON file path. Use files for screenshot artifacts and scenario captures, whose embedded PNG bytes can exceed the host's command-line length limit.
- Every surface has equivalent CLI and MCP contracts and returns Evidence provenance.
- MCP tools return complete results inline and include the Evidence ID. Session evidence can be exported with `export_evidence_bundle`.

Target discovery returns the complete in-scope target array in one result.

## Screenshot comparison memory budget

`compare_web_screenshots` admits both PNGs against a 256 MiB estimated
working-memory budget before inflating either image. This is a processing
buffer budget for this operation, not a PNG dimension limit, CDP transport
limit, or process RSS guarantee. Header-valid dimensions that exceed the
budget return `resource_constraint` with `details.resource: "memory"` and the
estimated and maximum working-set bytes. Invalid PNG structure remains
malformed input; encodings outside supported pixel-comparison coverage remain
unsupported-target errors.

The conservative estimate includes the two decoder-owned decoded input
buffers, the current image's concatenated IDAT buffer, Node zlib's default
16 KiB output chunk backing rounded up for retained chunks, the concatenated
inflate result while its output chunks are retained, one possible extra output
chunk before zlib checks `maxOutputLength`, unfiltered scanline storage,
RGB-to-RGBA expansion, and the first retained RGBA image while the second is
decoded. RGBA output aliases its unfiltered buffer and is counted once.
Admission uses checked integer arithmetic before image-sized allocation.
Caller-owned JSON/base64 strings, input parsing and validation, transport
buffers, garbage-collector behavior, and other runtime memory are outside this
estimate; the budget does not promise a bound on total process memory.

Electron `file://` pages use a separate provider and target boundary; see [electron-observation.md](electron-observation.md).

## Provider authorities

CDP page capture, V8 Inspector observation, and Playwright scenarios stay
separate providers because their authorities differ: CDP and V8 attach to an
already-running target and never launch, drive, evaluate, or mutate it, while
Playwright providers own and drive the runtime (launch browsers, run actions,
capture step snapshots). Merging them would mix attach-only and owned-process
lifecycles in one contract. What they share instead is one exclusion
vocabulary (`BrowserExclusionReason`): every denial reason in every stack maps
onto it, even where a wire schema keeps a narrower historical bucket.
Existing static application Evidence and passive web/Electron captures can be
combined later through
[JavaScript static/runtime reconciliation](javascript-runtime-reconciliation.md).

## Start a browser

Start a separate browser profile with an explicit debugging port. The exact executable name varies by platform and installation:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/rea-browser-profile \
  http://127.0.0.1:3000
```

REA does not launch, own, or terminate this browser. Use a dedicated profile and stop it yourself when the investigation is complete. Do not expose the debugging port on a non-loopback interface.

On Linux, a reachable but locked desktop keyring can stall Chrome before its
first navigation. For a dedicated investigation profile, add
`--password-store=basic` to bypass that keyring. Empty or placeholder frame URLs
then describe an unloaded page; REA continues to require an allowed, committed
URL. See [the startup investigation](https://github.com/morluto/rea/issues/1384#issuecomment-6093781686).

## Request boundary

CDP connections enforce the shared 64 MiB limit per WebSocket message. A larger
reply, including a valid reply from Chrome, fails with `payload_limit`. The limit
counts message bytes before JSON parsing; it does not bound the memory used by
decoded strings or JSON objects.

Discovery supplies a literal loopback CDP endpoint and returns all eligible
page targets unless an exact HTTP(S) origin filter narrows the result. Follow-up
inspection requests select one target; their default scope is its current origin. `localhost`, private-LAN
addresses, HTTPS CDP endpoints, credentials, paths, queries, fragments, and
implicit ports are not valid CDP endpoints. Origin filters contain only scheme,
host, and port; paths, credentials, queries, fragments, and wildcards are not
valid origins.

## CLI workflow

Pass the endpoint and selected target for each call. An origin filter is
optional and narrows the target set.

```bash
rea list-browser-targets http://127.0.0.1:9222 --json
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 1000 \
  --json
```

Static bundle analysis and a user-driven observation window are separate operations:

```bash
rea analyze-web-bundle http://127.0.0.1:9222 TARGET_ID \
  --json
rea observe-web-session http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 10000 --json
rea discover-webmcp-tools http://127.0.0.1:9222 TARGET_ID \
  --json
```

Accessibility names/descriptions, console primitive text, JSON body shapes, WebSocket shapes, script content, and storage key names are selected independently:

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --include-accessibility-text \
  --include-console-text \
  --include-json-body-shapes \
  --include-websocket-shapes \
  --include-script-sources \
  --include-storage-keys --include-storage-fingerprints \
  --json
```

Accessibility text, script content, query values, and explicitly requested primitive console text may contain application secrets and become part of the returned Evidence. URL username/password credentials are removed; ordinary query values, fragments, and parameter order remain intact. JSON and WebSocket captures retain complete paths, types, and counts, never values or examples. Storage values remain redacted even when key-name capture is requested. `--include-storage-fingerprints` requests SHA-256 identity/value fingerprints, which support comparison only when cookies, DOM storage, IndexedDB, and Cache Storage were all captured completely.

Screenshot capture returns the complete visible viewport as an inline image artifact:

```bash
rea capture-web-screenshot http://127.0.0.1:9222 TARGET_ID \
  --json
```

## Record session traffic as HAR

`observe_web_session` can also record the in-scope HTTP and WebSocket traffic of
a user-driven flow, across main-frame navigations, as one HAR 1.2 log in
`normalized_result.network.har`. Select it with the MCP `network` object or any
CLI network flag; without one the tool retains navigation metadata only. Export
the log and inspect it offline with
[`inspect_web_network_capture`](web-network-captures.md):

```bash
rea observe-web-session http://127.0.0.1:9222 TARGET_ID \
  --allowed-origins https://app.example.test \
  --allowed-origins https://api.example.test \
  --observation-ms 30000 \
  --network --response-bodies json --websocket-payloads \
  --sensitive-query-parameter device_id \
  --json > session.json
jq -c '.normalized_result.network.har' session.json > session.har
rea inspect-web-network-capture "$PWD/session.har" har --json
```

| MCP `network` field                        | CLI flag               | Retained when selected                                                                                                     |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `request_bodies`                           | `--request-bodies`     | Request bodies CDP reports with each request event, from their exact bytes; one that is not UTF-8 keeps only its size.     |
| `response_bodies`: `none`, `json` or `all` | `--response-bodies`    | Completed response bodies, read with `Network.getResponseBody` after loading finishes; `json` reads JSON media types only. |
| `header_values`                            | `--header-values`      | Request and response headers except `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`.                     |
| `websocket_payloads`                       | `--websocket-payloads` | Frame payloads: text frames as text, binary frames as base64.                                                              |

Unselected content is absent: header arrays are empty, a request body that was
not retained has `bodySize` `-1` unless CDP listed its bytes, and frames keep
only direction, opcode, time and byte size. HAR cookie arrays are always empty, and
transport credential headers are never retained; their count is reported in
`redactions.transport_credential_headers`. URL-valued headers (`Location`,
`Content-Location`, `Referer`, `Origin`, `Link` and `Refresh`) follow the request
scope: one that points outside the selected origins, or whose target cannot be
parsed, is omitted and counted in `redactions.out_of_scope_url_headers`, and
userinfo in a retained one, including a scheme-relative `//user:pass@host`
target, is removed and counted with the transport credentials. A header whose
userinfo cannot be cut out leaving the same target URL is omitted instead, and
so is one that REA's transport-URL parser reads as ambiguous, such as
`http:user:pass@host/` without `//`.
`Link` follows RFC 8288: its `anchor` parameter is a URL scoped and stripped
like a `<target>`, and a `<` or `>` outside a quoted-string, an unterminated
target or quoted-string, or an `anchor` value that is not a token or a
quoted-string without quoted-pairs makes it unparseable. `Refresh` targets
follow the HTML declarative refresh syntax, with or without `url=`; a delay
alone is kept. Chromium ends a quoted `Refresh` URL at its last matching quote
rather than the first, so a value with that quote again after its closing
quote is unparseable. Timings follow HAR 1.2: `send`, `wait`
and `receive` are non-negative and `time` is their sum; a phase REA did not
observe is `0`, and a response still loading when recording stopped says so in
its entry comment.

**Scope.** Requests and WebSocket handshakes use the same origin boundary as the
timeline. Out-of-scope requests, sockets and their frames are excluded and
counted in `completeness.excluded`. A redirect to an excluded origin keeps the
in-scope hop with an empty `redirectURL` and an entry comment. Recording stops
when the window elapses or the timeline ends, whichever is first; body reads that
already started still complete. Chrome runs out-of-process cross-site iframes and
the page's dedicated, shared and service workers as separate targets. REA does
not attach them, so their traffic is not recorded even when their origin is
selected, and a dedicated worker's script request can appear without its
response; a limitation says so.

**Declared sensitive values.** `sensitive_values` (`--sensitive-value`, repeatable)
lists literals to replace with `[REDACTED:value-N]` markers in every retained
URL, query parameter, header, body, WebSocket payload, timeline and browser
metadata field. Each field is
checked as written and in its UTF-8 percent-decoded, form-decoded and
JSON-unescaped forms, nested up to three levels, with invalid UTF-8 escapes read
as U+FFFD; HAR `queryString` names and values are checked again, after URL
decoding, as fields of their own; binary bodies and payloads are matched on
their decoded bytes and on their base64 text, and a declared value that the
base64 text spells fails the field closed, since base64 cannot be edited in place. A
declared value with an unpaired UTF-16
surrogate has no UTF-8 spelling and is matched as written or JSON-escaped.
Other spellings, such as percent-encoding in a legacy charset (`%E9` from a
windows-1252 form), HTML entities or base64 inside a header, are not detected;
declare them as values of their own. Only
the host, port, URL path segments, query pairs and fragment pieces that spell a
declared value are rewritten, so the rest of each URL keeps its exact bytes and
stays a valid URI. A host that spells a declared value becomes
`redacted.invalid` and keeps its port (`https://redacted.invalid:8443/`). A port
that spells one loses its digits and keeps its host and the `:` before it
(`https://app.example:/`): no browser writes an empty port, so it marks the
removed one, but a URL parser reads it as the scheme's default port. When both
spell declared values, the authority becomes `redacted.invalid:`, and a value
spanning the host and port fails the URL closed, as described below. When
`allowed_origins` is omitted, Evidence does not derive it from a target URL
whose host or port was redacted. Path segments, query pairs and fragment pieces
are rewritten with percent-encoded markers. A piece is redacted as written and
then decoded, since decoding can erase the spelling that matched (a query `+`
read as a space, a lowercase or unreserved escape); a piece whose result still
spells a declared value in any of the forms above, or in a query with its
spaces read back as `+`, is emptied.
A URL-valued header is rewritten piece by piece only
when its whole value is one absolute URL, as `Referer`, `Origin` and an
absolute `Location` or `Content-Location` are. A relative `Location` or
`Content-Location`, and every `Link` and `Refresh` value, is redacted as text:
its markers are not percent-encoded, so the value may no longer be a valid
URI-reference, and a declared value found only in a decoded spelling (a
lowercase or unreserved escape, or a nested encoding) empties the whole header
value. Declared values are matched as spelled, and
browsers report hosts lowercased and IDN hosts as punycode, so declare that
spelling to redact a host. Overlapping declared values are replaced as one
marker, so no part of either survives. A URL in which a declared value spans
pieces becomes `<scheme>//redacted.invalid/`, or `urn:redacted` or `x:y` when
that spells a declared value; a HAR entry whose URL none of these can stand in
for is omitted and counted in `completeness.excluded` as `provider_unavailable`:
a request under `network_requests`, and a WebSocket under
`websocket_connections` with its frames under `websocket_frames`. Any other field
in which a declared value survives replacement is emptied; an emptied query
flag stays as an empty `=` pair, so the remaining pairs keep their positions.
A body or WebSocket payload that redaction would empty is withheld instead, so
it never reads as empty content: a body keeps its size but not its text, its
entry comment says why, and it is counted under `network_bodies` as
`provider_unavailable`; a payload has `data: null`, is counted under
`websocket_frames` as `provider_unavailable`, and a limitation states how many. A
marker is chosen so that neither it nor its percent-encoding spells a declared
value; when none qualifies the value is removed without a marker. Target IDs,
MIME types, methods and the browser metadata in `browser` and
`har.log.browser`, which also names the Evidence environment, are redacted like
any other field. `redactions.explicit_value_fields` counts the HAR and network
target fields that changed: URLs, query parameter names and values, header
names and values, bodies, WebSocket payloads, entry comments, methods, status
texts, MIME types, resource types and target IDs, including those of HAR entries later omitted. The top-level `browser`,
`target` and `timeline` fields are redacted the same way but not counted.
`sensitive_query_parameters`
(`--sensitive-query-parameter`, repeatable) names exact query parameters; every
value observed for them in a retained URL is replaced wherever it appears.
Values are read only from the query string of each retained URL, including the
in-scope targets of retained URL-valued headers. Parameters inside a fragment,
such as a hash-routed `#/reset?token=...` or an implicit-grant
`#access_token=...`, are not read, so declare those values with
`sensitive_values`.
Evidence parameters keep the parameter names and the number of declared
literals, never the literals; a request parameter or parameter name that
spells one is left empty, and the result says so. REA does not infer sensitivity from names or
patterns: everything else, including query values and bodies, is retained
verbatim, so
treat the HAR as sensitive local evidence.

**Redaction cost.** With declared values, each retained body and payload is
checked in every decoding listed above before the result is returned. Memory
stays bounded, but the check is CPU-bound and runs after the window closes:
on the order of seconds for a 32 MiB body, and longer for content made mostly
of escapes.

**Budget and coverage.** Retained bodies and payloads share a 32 MiB budget,
equal to `inspect_web_network_capture`'s input budget and reported as
`content_budget_bytes`; `retained_content_bytes` reports what they used,
counted as received before redaction: UTF-8 bytes of text, and the base64 text
of base64 content. A response body read
reserves its base64 worst case while in flight. A body that does not fit is
omitted with an entry comment, and a frame payload that does not fit has `data:
null`; `network_bodies` or `websocket_frames` is then reported truncated. A body
whose CDP reply could exceed the 64 MiB message limit (Chrome escapes non-ASCII
text six-fold, so above about 10.6 MiB decoded) is not read, and its entry says
so. For the same reason, REA asks Chrome to inline selected request bodies
only up to about 7.9 MiB; a larger one is not retained, and its entry says it
was not exposed. That cap covers subresource requests such as `fetch` and XHR,
not navigations: Chrome inlines a form submission's body whole, as escaped text
and again as base64, whether or not request bodies are selected. A navigation's
request event therefore exceeds the message limit once its body passes 8.7 to
27 MiB, depending on how much of it Chrome escapes (about 15 MiB of two-byte
UTF-8 text); REA's connection then closes and the observation ends with
`window.end_reason` `target_terminated`. A
request body is taken from the exact bytes CDP lists in `postDataEntries`, not
from its `postData` text, which Chrome decodes as Latin-1 when the bytes are not
UTF-8; such a body is not retained, since HAR `postData` carries text only, so
its entry comment says why, `bodySize` reports its byte count and
`network_bodies` is reported unavailable. Without `postDataEntries`, the
`postData` text is retained as the browser reported it. Each
body read has a 5-second deadline; a read that misses it, a body still loading
when recording stopped, a body the browser has already released, a browser
without `Network.getResponseBody`, and reads still pending when the target ends
or disconnects are stated in their entry comments and reported unavailable. Malformed CDP content, including non-canonical base64, is
not retained and is counted as `invalid_protocol_value`. Transport and other
protocol failures fail the observation. Request and frame metadata are not
capped, and `har_bytes` reports the log's serialized size, with a limitation
when it exceeds the inspector's 32 MiB input budget. REA does not check the
96 MiB decoder reply limit: the decoder's reply is several times the log's
size, about five times for a log dominated by WebSocket frames, so such a log
can exceed the reply limit well below 32 MiB. Coverage starts at
`coverage_started_at`, after REA attaches, and `prior_activity_available` is
always `false`. Frames on sockets opened earlier have no URL to authorize and
are excluded as `unattributed_origin`.

## MCP input

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS"
}
```

The omitted observation window and capture options use conservative defaults.
Set an option only when the investigation needs that additional content.
Collection counts are not capped. Per-value validation, the selected observation
window, and CDP protocol limits still apply; any incomplete or truncated values
are reported in the result.

Call `list_browser_targets` first because target IDs are browser-instance-specific. REA rechecks the selected target's current type and origin immediately before attaching. Without an origin filter, discovery lists all eligible pages; an individual capture defaults to the selected page's current origin.

REA establishes a main-frame origin boundary before enabling Runtime, Debugger, or Network observation, rechecks it before document capture, and validates it again afterward. If the main frame navigates during final capture, REA discards the mixed result and returns `target_changed`.

## Data minimization

REA retains local observation data and removes only URL userinfo credentials, explicitly declared scenario secrets, and values from structured credential/storage fields:

- URL observations preserve the complete local URL, including query values, fragments, duplicate parameters, and their order. Only username/password userinfo is removed; malformed original URL strings remain available with `origin: null`.
- DOM snapshots retain node types, node names, value lengths, and attribute names, but not text or attribute values.
- Accessibility structure and roles are retained by default, while names and descriptions require `include_accessibility_text: true`.
- Network observations retain method, status, MIME type, size, type, initiator stack location, and complete URLs with userinfo credentials removed. Redirects reported by CDP are attached as ordered `redirects` on the one request ID, with the prior request URL, CDP response URL, method/type, response status/MIME/encoded length, request timestamp, and the next `requestWillBeSent` event timestamp. CDP delivers `redirectResponse` with that next request event, so the latter is an event boundary rather than an exact response timestamp. Redirect response headers and bodies are discarded; hops outside the selected origins are discarded with the request chain. Headers are discarded after an allowlisted projection of length/encoding, structured CSP/Link/policy fields, and untrusted agent hints. Cookies and authorization headers are never retained.
- For `inspect_web_page`, request/response bodies are not requested or parsed by default. When selected, only allowed-origin JSON media types are read, converted immediately to complete value-free typed paths, types and observation counts, and discarded. Each path segment is either `{ "kind": "property", "name": "raw property name" }` or `{ "kind": "array-element" }`; array-element types include primitives and nested arrays. Literal `*` properties remain distinct from array elements. `Network.getResponseBody` is never sent unless JSON body shape capture is selected. Comparison uses body shapes only when both captures selected them, and compares request/response shapes only where both observations provide those facts. Unavailable or truncated selected coverage makes equivalence unknown; observed differences still report changed.
- `observe_web_session` retains selected request and response bodies and WebSocket payloads verbatim, as described in [Record session traffic as HAR](#record-session-traffic-as-har).
- Console observations with a stack source retain call type, argument types, timestamp, and source location. When console text capture is selected, already-delivered primitive values are retained verbatim; objects, getters, and remote properties are never expanded.
- For `inspect_web_page`, WebSocket observations retain direction, opcode, and payload byte length. When shape capture is selected, text frames are classified as text or complete value-free JSON shape; binary bytes, hashes, prefixes, and raw frames are never retained.
- Storage observations always redact values. Key names, IndexedDB names, and cache names require `include_storage_keys`; stable content fingerprints require the additional `include_storage_fingerprints` selection. Cookie fingerprints cover cookies applicable to the current main-frame URL, including its path, rather than every cookie path on that origin. Other storage remains scoped to the origin. Cache bodies above 64 KiB and partial IndexedDB remote objects make fingerprint coverage incomplete, so identical observations remain `unknown`.
- Script metadata is included only when CDP supplies a URL on an allowed origin. Stable keys exclude transient CDP script IDs, and exact transient raw URLs are used only during script/resource reconciliation. URL-less scripts are excluded because their origin cannot be established. When CDP supplies an execution-context association, the accepted script retains its authorized frame ID for later attribution. Script metadata admission bounds retained identity and source-map strings to 8 MiB and 50,000 records. When a source-map URL cannot fit, the script identity remains and source-map coverage reports `resource_budget_exhausted`; rejected script observations are counted without retaining their IDs. Source content is omitted unless explicitly requested and is returned inline as a self-verifying artifact with its SHA-256 digest.

Frames, resources, scripts, events, and workers outside the selected origin scope are excluded. An explicit `allowed_origins` list can include additional origins; excluded target details are counted without being exposed.
Retained workers include validated opener-target and parent-frame IDs when CDP
provides them; these relationships do not expand the exact-origin boundary or
prove static module ownership.

## Completeness and limits

The default inspection window is 500 ms; callers choose its duration. The
capture returns in-scope frames, DOM and accessibility nodes, admitted scripts,
resources, workers, storage names, and observed network, console, and WebSocket
events. Full selected text, script sources, and JSON shapes are returned inline.
The result distinguishes
`complete_within_window`, `policy_filtered`, `attach_limited`, and `truncated`
coverage. It reports excluded items and any values omitted or truncated by
validation and resource bounds. Omitted script metadata makes its affected
section explicitly truncated.
Disallowed-origin entries are filtered before retention.

CDP discovery, WebSocket connection, and commands continue until the peer responds or the caller cancels the operation; REA has no internal byte, message-count, or pending-command quota for these exchanges. Without caller cancellation, a stalled peer can leave an operation waiting. On cancellation, REA closes only its own WebSocket, waiting up to one second before terminating it. Malformed unsolicited events and malformed replies to pending commands poison the connection so later commands fail closed. When a correlated reply reports a session ID, it must match the command's selected session. An optional method is reported unavailable only when the browser rejects it as unknown; other command rejections retain their reported failure.

Network and console coverage starts only after REA attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred. If CDP reuses a request ID without supplying redirect metadata, REA retains the predecessor observation and marks network coverage incomplete.

Source maps are not fetched by inspection. Bundle analysis fetches them only when `fetch_source_maps` is selected, with exact-origin redirect checks and no credentials, cookies, or referrer. Each fetch operation has a 30-second deadline and a 64 MiB aggregate streamed-response budget across redirects. A deadline or byte-limit failure remains explicitly unavailable and makes bundle completeness partial. Source-map decoding also bounds raw resolved identities to 64 MiB and aggregate inline evidence to 32 MiB. Failed maps preserve their failure context when it fits; if another context cannot fit, collection stops with the full requested count, the returned processed count, and an explicit unknown-results limitation. Retained mappings and original sources are returned inline. See [source-location limits](web-source-location.md) for the structural decoder bounds. Original source artifacts with `.ts`, `.tsx`, `.mts`, or `.cts` suffixes carry `text/typescript`; other source names retain `text/javascript`.

source-map items retain the script's `declared_url` separately from the observed
`effective_url`. successful maps use the latter as their source-resolution base.
failed fetches retain the last response URL observed within the approved origins;
`effective_url` is `null` when no response was observed. query parameters are
preserved, and both URLs count toward the inline evidence budget.
Current fetches emit a string or null; historical observations may omit
`effective_url` without changing their stored content or Evidence identity.
An observed URL must fit before its response body is read. If it cannot fit,
remaining map results are explicitly unknown; failed cancellation retains its
cleanup context and resource constraint.

## Non-goals and threat model

The browser provider deliberately does not expose generic CDP commands, `Runtime.evaluate`, WebMCP invocation, navigation, input, downloads, page closure, or browser closure. Screenshot capture is the sole pixel surface and returns an image only when requested. REA disables the domains it enabled, detaches the target session, and closes only its own WebSocket.

This feature is not a browser sandbox or network containment mechanism. The attached page and browser continue running with their existing privileges and may make external requests independently of REA. CDP gives deep access to the selected browser profile, so use a dedicated profile, include only origins you intend to inspect, and treat other same-user processes as outside this boundary.

Response metadata normalizes a `Referrer-Policy` fallback list to its last recognized nonempty policy, including mixed-case tokens. Unknown policy names are skipped; malformed token syntax and lists without a recognized policy remain `null`. This reports the response's declared policy, not the effective policy of a document or an inferred browser default.
