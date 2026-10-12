import type { WebObservationSession } from "../domain/browserSession.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  SESSION_NETWORK_LIMITATIONS,
  sessionNetworkEvidence,
} from "./CdpSessionHar.js";
import type { CdpSessionNetwork } from "./CdpSessionNetwork.js";

type TimelineEvent = WebObservationSession["timeline"][number];

/** Navigation facts one observation window retained. */
export interface RecordedTimeline {
  readonly initialUrl: string | null;
  readonly finalUrl: string | null;
  readonly timeline: readonly TimelineEvent[];
}

/** Assemble the session result and its limitations. */
export const sessionResult = (input: {
  readonly browser: WebObservationSession["browser"];
  readonly targetId: string;
  readonly capture: RecordedTimeline;
  readonly network: CdpSessionNetwork | undefined;
  readonly completeness: CdpCaptureCompleteness;
  readonly limitations: readonly string[];
  readonly window: WebObservationSession["window"];
  readonly coverageStartedAt: Date;
}): WebObservationSession => {
  const { capture, network } = input;
  const networkEvidence =
    network === undefined
      ? undefined
      : sessionNetworkEvidence({
          network,
          browser: input.browser,
          coverageStartedAt: input.coverageStartedAt,
        });
  return {
    browser: input.browser,
    target: {
      target_id: input.targetId,
      initial_url: capture.initialUrl ?? "",
      final_url: capture.finalUrl,
    },
    window: input.window,
    timeline: [...capture.timeline],
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
      ...input.limitations,
    ],
  };
};
