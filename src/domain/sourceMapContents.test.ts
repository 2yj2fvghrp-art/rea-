import { expect, it } from "vitest";

import { hasValidSourceMapContents } from "./sourceMapContents.js";

it("validates content types without requiring a source inventory", () => {
  expect(hasValidSourceMapContents(undefined)).toBe(true);
  expect(hasValidSourceMapContents(null)).toBe(true);
  expect(hasValidSourceMapContents([null, "retained source"])).toBe(true);
  expect(hasValidSourceMapContents(["retained source"])).toBe(true);
  expect(hasValidSourceMapContents([])).toBe(true);
  expect(hasValidSourceMapContents("source")).toBe(false);
  expect(hasValidSourceMapContents([null, 42])).toBe(false);
});
