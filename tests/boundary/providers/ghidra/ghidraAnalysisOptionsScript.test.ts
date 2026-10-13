import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The analyzer-options pre-script runs inside real Ghidra, which this machine
// cannot exercise. Its fail-closed contract is still load-bearing: Ghidra's
// setAnalysisOption only logs unknown names and silently skips values it
// cannot apply, so a typo would let the real analyzer run while the analysis
// profile records it as disabled. These tests pin the packaged script's source
// to the contract: validate every requested name against the program's
// registered analyzer options, read each back as disabled, and abort before
// auto-analysis and bridge startup otherwise.

const scriptPath = fileURLToPath(
  new URL(
    "../../../../bridge/ghidra/ReaGhidraAnalysisOptions.java",
    import.meta.url,
  ),
);

const script = () => readFile(scriptPath, "utf8");

describe("ReaGhidraAnalysisOptions fail-closed contract", () => {
  it("validates requested names against the program's registered analysis options", async () => {
    const source = await script();
    expect(source).toContain("Program.ANALYSIS_PROPERTIES");
    expect(source).toContain("analysisOptions.contains(name)");
  });

  it("only disables boolean analyzer enable flags", async () => {
    const source = await script();
    expect(source).toContain("OptionType.BOOLEAN_TYPE");
  });

  it("reads each option back as disabled after applying it", async () => {
    const source = await script();
    expect(source).toContain("analysisOptions.getBoolean(name, true)");
    expect(
      source.indexOf('setAnalysisOption(currentProgram, name, "false")'),
    ).toBeLessThan(source.indexOf("analysisOptions.getBoolean(name, true)"));
  });

  it("aborts with an exception when a name is unknown or cannot be applied", async () => {
    const source = await script();
    const abort = source.indexOf("unknown.isEmpty() || !unapplied.isEmpty()");
    expect(abort).toBeGreaterThan(-1);
    const throwStatement = source.indexOf(
      "throw new IllegalArgumentException",
      abort,
    );
    expect(throwStatement).toBeGreaterThan(-1);
    expect(throwStatement).toBeGreaterThan(
      source.indexOf("analysisOptions.getBoolean(name, true)"),
    );
  });

  it("still requires exactly one comma-separated argument", async () => {
    const source = await script();
    expect(source).toContain("arguments.length != 1 || arguments[0].isBlank()");
  });
});
