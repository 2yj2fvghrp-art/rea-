import type { FakeOptions } from "./fakeCdpBrowserTypes.js";

type FakeCommand = Parameters<NonNullable<FakeOptions["commandResult"]>>[0];

/**
 * Replies for the target-domain commands observe_web_session sends when
 * network capture is selected; the stock fake does not implement them.
 */
export const sessionNetworkTargetResult = (
  command: FakeCommand,
  origin: string,
): Readonly<Record<string, unknown>> | undefined => {
  switch (command.method) {
    case "Target.setAutoAttach":
    case "Target.setDiscoverTargets":
    case "Runtime.runIfWaitingForDebugger":
      return {};
    case "Target.getTargetInfo":
      return {
        targetInfo: {
          targetId: "allowed-page",
          type: "page",
          url: `${origin}/`,
          browserContextId: "context-1",
        },
      };
    default:
      return undefined;
  }
};
