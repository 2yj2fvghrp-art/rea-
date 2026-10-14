import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

describe("conditionally initialized JavaScript bindings", () => {
  it.each([
    "if (condition) { var result = 1; }",
    "while (condition) { var result = 1; break; }",
    "switch (condition) { case true: var result = 1; }",
    "try { if (!condition) throw 0; var result = 1; } catch (error) {}",
    "let result; if (condition) { result = 1; }",
    "var result; condition && (result = 1);",
    "var result; condition || (result = 1);",
    "var result; condition ?? (result = 1);",
    "var result; condition ? (result = 1) : 0;",
    "var result; condition ? 0 : (result = 1);",
  ])("does not treat %s as a definite literal", (declarations) => {
    const analysis = analyzeJavaScriptSemantics(
      `${declarations} function read() { return result; } read();`,
    );
    const binding = analysis.bindings.find((entry) => entry.name === "result");
    const callable = analysis.callables.find((entry) => entry.name === "read");
    expect(binding?.value).not.toEqual({ status: "literal", value: 1 });
    expect(callable?.returnSites[0]?.value).not.toEqual({
      status: "literal",
      value: 1,
    });
  });

  it("keeps an assignment on the always-run side exact", () => {
    const analysis = analyzeJavaScriptSemantics(
      "var result; (result = 1) && condition; function read() { return result; }",
    );
    expect(
      analysis.bindings.find((entry) => entry.name === "result")?.value,
    ).toEqual({ status: "literal", value: 1 });
  });

  it("keeps an unconditional var initializer exact", () => {
    const analysis = analyzeJavaScriptSemantics(
      "var result = 1; function read() { return result; }",
    );
    expect(
      analysis.bindings.find((entry) => entry.name === "result")?.value,
    ).toEqual({
      status: "literal",
      value: 1,
    });
  });
});
