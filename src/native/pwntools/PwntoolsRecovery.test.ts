import { describe, expect, it } from "vitest";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import {
  pwntoolsDecoderFailure,
  pwntoolsUnavailable,
} from "./PwntoolsFailures.js";

describe("pwntools recovery guidance", () => {
  it("projects the actual configuration key and refusal without losing output", () => {
    const reason = "The configured input limit must be a decimal integer.";
    const capturedOutput = {
      stdout: "",
      stderr: "decoder diagnostic",
      truncated: true,
    };
    const projected = projectAnalysisError(
      pwntoolsUnavailable(
        reason,
        "/selected/python",
        undefined,
        capturedOutput,
        {
          operation: "inspect_recorded_crash",
          providerId: "pwntools-elf",
          configurationKey: "REA_PWNTOOLS_MAX_INPUT_BYTES",
        },
      ),
    );
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      message: `REA_PWNTOOLS_MAX_INPUT_BYTES: ${reason}`,
      remediation: { action: `REA_PWNTOOLS_MAX_INPUT_BYTES: ${reason}` },
      details: {
        operation: "inspect_recorded_crash",
        requested_provider_id: "pwntools-elf",
        captured_output: capturedOutput,
        rejections: [
          {
            reason,
            diagnostics: {
              configuration_key: "REA_PWNTOOLS_MAX_INPUT_BYTES",
              executable_path: "/selected/python",
            },
          },
        ],
      },
    });
  });

  it("names the selected Python and launch failure in caller recovery", () => {
    const projected = projectAnalysisError(
      pwntoolsDecoderFailure(
        Object.assign(new Error("spawn failed"), {
          code: "ENOENT",
          syscall: "spawn /selected/python",
        }),
        "decoder",
        "/selected/target",
        "/selected/python",
      ),
    );
    expect(projected.message).toContain("REA_PWNTOOLS_PYTHON");
    expect(projected.message).toContain(
      "Selected Python could not launch (ENOENT): /selected/python",
    );
    expect(projected.remediation.action).toBe(projected.message);
    expect(projected.message).not.toContain("rea doctor");
  });

  it.each(["hopper", "ghidra", "ida"])(
    "preserves default doctor recovery for %s",
    (providerId) => {
      const projected = projectAnalysisError(
        new ProviderSelectionError({
          reason: "provider_unavailable",
          requestedProviderId: providerId,
          candidateIds: [providerId],
        }),
      );
      expect(projected.message).toContain("rea doctor");
      expect(projected.remediation.action).toBe(projected.message);
    },
  );
});
