import type {
  ObserveWebSessionInput,
  WebObservationSession,
} from "../domain/browserSession.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  SESSION_NETWORK_LIMITATIONS,
  sessionNetworkEvidence,
} from "./CdpSessionHar.js";
import type { CdpSessionNetwork } from "./CdpSessionNetwork.js";
import { declaredQueryValues, SessionRedactor } from "./SessionRedactor.js";

type TimelineEvent = WebObservationSession["timeline"][number];

/** Navigation facts one observation window retained. */
export interface RecordedTimeline {
  readonly initialUrl: string | null;
  readonly finalUrl: string | null;
  readonly timeline: readonly TimelineEvent[];
  retainedUrls(): Iterable<string>;
}

/** Assemble the result, replacing declared literals and parameter values throughout. */
export const redactedSessionResult = (input: {
  readonly request: ObserveWebSessionInput;
  readonly browser: WebObservationSession["browser"];
  readonly targetId: string;
  readonly capture: RecordedTimeline;
  readonly network: CdpSessionNetwork | undefined;
  readonly completeness: CdpCaptureCompleteness;
  readonly limitations: readonly string[];
  readonly window: WebObservationSession["window"];
  readonly coverageStartedAt: Date;
}): WebObservationSession => {
  const { request, capture, network } = input;
  const redactor = new SessionRedactor([
    ...request.sensitive_values,
    ...declaredQueryValues(
      [...capture.retainedUrls(), ...(network?.retainedUrls() ?? [])],
      request.sensitive_query_parameters,
    ),
  ]);
  // One copy serves the result and har.log.browser, redacted before network
  // fields are counted; a custom User-Agent repeats the request header.
  const browser = {
    product: redactor.text(input.browser.product),
    protocol_version: redactor.text(input.browser.protocol_version),
    revision: redactor.text(input.browser.revision),
    user_agent: redactor.text(input.browser.user_agent),
    js_version: redactor.text(input.browser.js_version),
  };
  const networkEvidence =
    network === undefined
      ? undefined
      : sessionNetworkEvidence({
          network,
          browser,
          coverageStartedAt: input.coverageStartedAt,
          redactor,
        });
  return {
    browser,
    target: {
      target_id: redactor.text(input.targetId),
      initial_url: redactor.url(capture.initialUrl ?? ""),
      final_url:
        capture.finalUrl === null ? null : redactor.url(capture.finalUrl),
    },
    window: input.window,
    timeline: capture.timeline.map((event) =>
      redactedTimelineEvent(event, redactor),
    ),
    ...(networkEvidence === undefined ? {} : { network: networkEvidence }),
    completeness: input.completeness.snapshot(),
    limitations: [
      "The timeline begins after REA attaches; earlier navigation and network activity is unavailable.",
      ...(network === undefined
        ? [
            "Only navigation metadata is retained because network was not selected; no requests, headers, bodies, cookies, console values, or payloads were captured.",
          ]
        : SESSION_NETWORK_LIMITATIONS),
      "An out-of-policy destination ends collection immediately and is recorded without its URL.",
      ...(requestSpellsLiteral(request)
        ? [
            "A request parameter spells a declared sensitive value and is left empty in the Evidence parameters.",
          ]
        : []),
      // Worker limitations name targets and quote browser error text.
      ...input.limitations.map((limitation) => redactor.text(limitation)),
    ],
  };
};

/** Mirrors the Evidence parameters, which blank every request string and string list item that spells one. */
const requestSpellsLiteral = (request: ObserveWebSessionInput): boolean =>
  Object.entries(request).some(
    ([name, value]) =>
      name !== "sensitive_values" &&
      [value]
        .flat()
        .some(
          (item) =>
            typeof item === "string" &&
            request.sensitive_values.some((literal) => item.includes(literal)),
        ),
  );

/** Every page-derived timeline string can spell a declared literal. */
const redactedTimelineEvent = (
  event: TimelineEvent,
  redactor: SessionRedactor,
): TimelineEvent => {
  const text = (value: string | null) =>
    value === null ? null : redactor.text(value);
  return {
    ...event,
    frame_id: text(event.frame_id),
    loader_id: text(event.loader_id),
    request_id: text(event.request_id),
    url: event.url === null ? null : redactor.url(event.url),
    detail: text(event.detail),
  };
};
