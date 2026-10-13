import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "./contracts/errorSchemas.js";
import { AnalysisError } from "./domain/analysisErrorBase.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "./domain/analysisErrorProjection.js";
import type { Logger } from "pino";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Identify caller-visible CLI outcomes that mean the requested operation failed. */
export const isCliOperationFailure = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (
    isRecord(value.error) &&
    analysisErrorProjectionSchema.safeParse(value.error).success
  )
    return true;
  if (analysisCliErrorEnvelopeSchema.safeParse(value).success) return true;
  if (analysisErrorProjectionSchema.safeParse(value).success) return true;
  if (value.healthy === false) return true;
  return false;
};

/**
 * Failure decision from the most recent logCliCommand call, awaiting output
 * rendering. Commands with their own failure check (setup, update, uninstall)
 * decide failure here; the streamed JSON writer consumes the decision so its
 * envelope agrees with the exit code.
 */
let pendingCommandFailure: boolean | undefined;

/** Publish the failure decision logCliCommand just applied to the exit code. */
export const recordCliCommandFailureDecision = (failed: boolean): void => {
  pendingCommandFailure = failed;
};

/** Consume the published failure decision, if a command published one. */
export const takeCliCommandFailureDecision = (): boolean | undefined => {
  const failed = pendingCommandFailure;
  pendingCommandFailure = undefined;
  return failed;
};

/** Log one CLI command with duration and a stable success or failure status. */
export const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
  isCommandFailure?: (value: Value) => boolean,
): Promise<Value | AnalysisErrorProjection> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    const failed = isCommandFailure?.(value) ?? isCliOperationFailure(value);
    recordCliCommandFailureDecision(failed);
    logger[failed ? "error" : "info"](
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: failed ? "error" : "ok",
      },
      failed ? "CLI command failed" : "CLI command completed",
    );
    if (failed) process.exitCode = 1;
    return value;
  } catch (cause: unknown) {
    process.exitCode = 1;
    logger.error(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "error",
      },
      "CLI command failed",
    );
    if (cause instanceof AnalysisError) {
      process.exitCode = 1;
      recordCliCommandFailureDecision(true);
      return projectAnalysisError(cause);
    }
    throw cause;
  }
};
