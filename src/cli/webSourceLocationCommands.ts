import { z } from "incur";
import { createWebSourceLocationService } from "../composition/webSourceLocations.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import type { Evidence } from "../domain/evidence.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit selected map/point contract through the CLI. */
export const registerWebSourceLocationCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  service = createWebSourceLocationService(environment),
): void => {
  cli.command(CLI_COMMANDS.traceWebSourceLocation, {
    description:
      "Trace one retained script position through an explicitly selected local source map",
    args: z.object({
      manifestPath: z
        .string()
        .describe("Absolute export_web_scripts manifest path"),
      scriptIndex: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Zero-based manifest script index"),
      sourceMapPath: z.string().describe("Absolute local source-map path"),
      sourceMapUrl: z
        .string()
        .describe("Absolute source-map URL context; no fetch"),
      line: z.coerce.number().int().min(1).describe("One-based generated line"),
      column: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Zero-based UTF-16 generated column"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        return await logCliCommand(
          logger,
          CLI_COMMANDS.traceWebSourceLocation,
          async () => {
            let primary: Result<Evidence, AnalysisError> | undefined;
            let executionError: unknown;
            try {
              primary = await service.trace(
                {
                  manifest_path: args.manifestPath,
                  script_index: args.scriptIndex,
                  source_map: {
                    path: args.sourceMapPath,
                    url: args.sourceMapUrl,
                  },
                  generated_position: { line: args.line, column: args.column },
                },
                { signal },
              );
            } catch (cause: unknown) {
              executionError = cause;
            }
            let cleanupError: AnalysisError | undefined;
            try {
              await service.close();
            } catch (cause: unknown) {
              if (cause instanceof AnalysisError) {
                cleanupError = cause;
              } else {
                throw cause;
              }
            }
            if (executionError !== undefined) throw executionError;
            if (primary !== undefined) {
              if (cleanupError !== undefined) {
                const error = primary.ok
                  ? cleanupError
                  : analysisErrorWithCleanupFailure(
                      primary.error,
                      cleanupError,
                      "trace_web_source_location",
                    );
                return projectAnalysisError(error);
              }
              return primary.ok
                ? primary.value
                : projectAnalysisError(primary.error);
            }
            throw new Error("Unreachable: missing trace result and error");
          },
        );
      }),
  });
};
