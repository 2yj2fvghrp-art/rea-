import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createStreamedCliJsonOutput } from "../../../src/cli/streamedJsonOutput.js";
import { logCliCommand } from "../../../src/cliLogging.js";
import { silentLogger } from "../../../src/logger.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

const runWrite = async (
  value: unknown,
  args: readonly string[],
): Promise<unknown> => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const output = createStreamedCliJsonOutput(args, destination);
  expect(output).toBeDefined();
  const written = await output!.write(value, {
    command: "inspect-managed-artifact",
    duration: "12ms",
    format: "json",
  });
  expect(written).toBe(true);
  expect(output!.handled).toBe(true);
  return JSON.parse(chunks.join(""));
};

const fullOutputArgs = ["--format", "json", "--full-output"] as const;

describe("streamed CLI JSON full-output envelope", () => {
  it("wraps successful results in a success envelope", async () => {
    await expect(
      runWrite({ operation: "inspect_managed_artifact" }, fullOutputArgs),
    ).resolves.toEqual({
      ok: true,
      data: { operation: "inspect_managed_artifact" },
      meta: { command: "inspect-managed-artifact", duration: "12ms" },
    });
  });

  it("reports CLI error envelopes as failures instead of success data", async () => {
    const failure = {
      error: "Analysis failed",
      ...projectAnalysisError(new ConfigurationError("source setting")),
    };
    await expect(runWrite(failure, fullOutputArgs)).resolves.toEqual({
      ok: false,
      error: failure,
      meta: { command: "inspect-managed-artifact", duration: "12ms" },
    });
  });

  it("reports bare analysis error projections as failures", async () => {
    const failure = projectAnalysisError(
      new ConfigurationError("source setting"),
    );
    await expect(runWrite(failure, fullOutputArgs)).resolves.toEqual({
      ok: false,
      error: failure,
      meta: { command: "inspect-managed-artifact", duration: "12ms" },
    });
  });

  it("leaves the bare failure projection untouched without --full-output", async () => {
    const failure = {
      error: "Analysis failed",
      ...projectAnalysisError(new ConfigurationError("source setting")),
    };
    await expect(runWrite(failure, ["--format", "json"])).resolves.toEqual(
      failure,
    );
  });

  it("reports failure when logCliCommand applies a custom failure check", async () => {
    // Mirrors setup/update/uninstall: the value is not an analysis error
    // projection, but the command's own check fails it and sets exit code 1.
    const previousExitCode = process.exitCode;
    try {
      const value = await logCliCommand(
        silentLogger,
        "setup",
        async () => ({ status: "needs_confirmation" }),
        (result: { status: string }) =>
          result.status === "needs_confirmation" ||
          result.status === "needs_human",
      );
      expect(process.exitCode).toBe(1);
      await expect(runWrite(value, fullOutputArgs)).resolves.toEqual({
        ok: false,
        error: value,
        meta: { command: "inspect-managed-artifact", duration: "12ms" },
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("keeps ok:false when --filter-output removes the failure-identifying fields", async () => {
    const failure = {
      error: "Analysis failed",
      ...projectAnalysisError(new ConfigurationError("source setting")),
    };
    await expect(
      runWrite(failure, [
        "--format",
        "json",
        "--filter-output",
        "message",
        "--full-output",
      ]),
    ).resolves.toEqual({
      ok: false,
      error: failure.message,
      meta: { command: "inspect-managed-artifact", duration: "12ms" },
    });
  });
});
