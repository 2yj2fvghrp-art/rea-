import { expect, it } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import {
  clearSemanticValueCaches,
  evaluateSemanticBinding,
} from "./javascriptSemanticValues.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const property = (
  value: JavaScriptSemanticValue,
  name: string,
): JavaScriptSemanticValue => {
  if (value.status !== "object")
    throw new Error(`Expected object at ${name}, got ${value.status}`);
  const result = value.properties.find((entry) => entry.name === name)?.value;
  if (result === undefined) throw new Error(`Missing ${name}`);
  return result;
};

it.each([false, true])(
  "recomputes a shared cyclic value under a different active ancestor (prewarmed: %s)",
  (prewarmed) => {
    const parsed = parseJavaScriptSource(
      `
const a = { shared: common, own: "a" };
const b = { shared: common, own: "b" };
const common = { a, b };
const result = { first: a, second: b };
`,
      "cycles.js",
    );
    if (parsed === null) throw new Error("Expected parsed source");
    const steps = indexJavaScriptBindingsSteps(parsed.program);
    let step = steps.next();
    while (step.done !== true) step = steps.next();
    const state = step.value;
    const binding = [...state.bindingsById.values()].find(
      (entry) => entry.name === "result",
    );
    if (binding === undefined) throw new Error("Missing result binding");
    if (prewarmed)
      for (const entry of state.bindingsById.values())
        if (entry.name === "a" || entry.name === "b")
          evaluateSemanticBinding(entry, state);
    const value = evaluateSemanticBinding(binding, state);
    const firstCommon = property(property(value, "first"), "shared");
    const secondCommon = property(property(value, "second"), "shared");
    expect(property(firstCommon, "a").status).toBe("cycle");
    expect(property(property(firstCommon, "b"), "own")).toEqual({
      status: "literal",
      value: "b",
    });
    expect(property(secondCommon, "b").status).toBe("cycle");
    expect(property(property(secondCommon, "a"), "own")).toEqual({
      status: "literal",
      value: "a",
    });
  },
);

it("invalidates retained alias values at the producing mutation boundary", () => {
  const parsed = parseJavaScriptSource(
    "const target = { value: 1 }; const alias = target; const root = { alias };",
    "mutation.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const target = [...state.bindingsById.values()].find(
    ({ name }) => name === "target",
  );
  const root = [...state.bindingsById.values()].find(
    ({ name }) => name === "root",
  );
  if (target === undefined || root === undefined)
    throw new Error("Missing binding");
  expect(
    property(property(evaluateSemanticBinding(root, state), "alias"), "value"),
  ).toEqual({ status: "literal", value: 1 });
  target.mutatedPaths.push(["value"]);
  clearSemanticValueCaches(state);
  expect(
    property(property(evaluateSemanticBinding(root, state), "alias"), "value")
      .status,
  ).toBe("unknown");
});
