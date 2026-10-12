import { z } from "incur";
import { resolve } from "node:path";
import { createSignalRecordingService } from "../composition/signals.js";
import { decodeSignalRecordingInputSchema } from "../domain/signals/signalRecording.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
export const registerSignalCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createSignalRecordingService(environment);
  cli.command(CLI_COMMANDS.decodeSignalRecording, {
    description:
      "Decode an existing signal recording with caller-supplied sigrok",
    args: z.object({ path: z.string().describe("Local signal recording") }),
    options: decodeSignalRecordingInputSchema.omit({ path: true }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            CLI_COMMANDS.decodeSignalRecording,
            async () => {
              const result = await service.decode(
                { ...options, path: resolve(args.path) },
                { signal },
              );
              return result.ok
                ? result.value
                : projectAnalysisError(result.error);
            },
          );
        } finally {
          await service.close();
        }
      }),
  });
};
