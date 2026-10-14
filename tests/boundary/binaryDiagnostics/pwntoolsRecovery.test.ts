import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { PwntoolsLayoutProvider } from "../../../src/native/pwntools/PwntoolsLayoutProvider.js";
import { PwntoolsRecordedCrashProvider } from "../../../src/native/pwntools/PwntoolsRecordedCrashProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe.runIf(process.platform === "linux" && process.arch === "x64").each([
  ["inspect_binary_layout", PwntoolsLayoutProvider],
  ["inspect_recorded_crash", PwntoolsRecordedCrashProvider],
] as const)("%s configuration recovery", (operation, Provider) => {
  it.each([
    ["unset", "absolute caller-supplied Python executable"],
    ["directory", "not a directory"],
    ["missing", "unavailable (ENOENT)"],
  ])("reports actionable guidance for %s Python", async (scenario, reason) => {
    const root = await createTestTempDirectory("rea-pwntools-recovery-");
    const executable =
      scenario === "directory" ? root : join(root, "missing-python");
    const provider = new Provider(
      scenario === "unset" ? {} : { REA_PWNTOOLS_PYTHON: executable },
    );
    onTestFinished(async () => {
      await provider.close();
    });
    const result = await provider.inspect({
      path: join(root, "unread-target"),
      include_debugger_context: false,
    });
    if (result.ok)
      throw new Error("Expected configuration refusal before target access");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      details: {
        operation,
        rejections: [
          { diagnostics: { configuration_key: "REA_PWNTOOLS_PYTHON" } },
        ],
      },
    });
    expect(projected.message).toContain("REA_PWNTOOLS_PYTHON");
    expect(projected.message).toContain(reason);
    expect(projected.message).not.toContain("rea doctor");
    expect(projected.remediation.action).toBe(projected.message);
  });
});
