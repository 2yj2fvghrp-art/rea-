import { z } from "incur";
import { createIosSimulatorCaptureService } from "../composition/iosSimulator.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Capture an already-booted iOS Simulator display through the shared service. */
export const registerIosSimulatorCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createIosSimulatorCaptureService();
  cli.command(CLI_COMMANDS.captureIosSimulatorScreen, {
    description:
      "Capture one booted iOS Simulator display as a complete PNG Evidence result",
    args: z.object({
      simulatorUdid: z
        .string()
        .describe("Exact CoreSimulator UDID; no booted alias"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.captureIosSimulatorScreen,
          async () => {
            const result = await service.execute(
              { simulator_udid: args.simulatorUdid },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          },
        ),
      ),
  });
};
