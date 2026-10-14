import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const components = (source: string) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.functionFingerprints).toHaveLength(1);
  const fingerprint = ir.functionFingerprints[0];
  if (fingerprint === undefined)
    throw new Error("Expected a function fingerprint");
  expect(fingerprint.status).toBe("complete");
  return fingerprint.components;
};

it.each([
  [
    "increment",
    "function sample(value) { return value++; }",
    "function sample(value) { return ++value; }",
  ],
  [
    "decrement",
    "function sample(value) { return value--; }",
    "function sample(value) { return --value; }",
  ],
  [
    "yield delegation",
    "function* sample(values) { yield values; }",
    "function* sample(values) { yield* values; }",
  ],
])("retains %s distinctions in normalized syntax", (_name, plain, changed) => {
  const left = components(plain);
  const right = components(changed);
  expect(right.normalizedAstSha256).not.toBe(left.normalizedAstSha256);
  expect(right.parameterArity).toBe(left.parameterArity);
  expect(right.literalSetSha256).toBe(left.literalSetSha256);
  expect(right.controlFlowSha256).toBe(left.controlFlowSha256);
});

it.each([
  [
    "function sample(value) { return value++; }",
    "function renamed(item) {\n  return item++ ;\n}",
  ],
  [
    "function sample(value) { return --value; }",
    "function renamed(item) {\n  return --item ;\n}",
  ],
  [
    "function* sample(values) { yield* values; }",
    "function* renamed(items) {\n yield * items ;\n}",
  ],
])(
  "keeps identifier and formatting normalization for %s",
  (original, renamed) => {
    expect(components(renamed)).toEqual(components(original));
  },
);
