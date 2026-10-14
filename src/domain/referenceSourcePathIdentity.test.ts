import { expect, it, vi } from "vitest";
import { createReferenceSourcePathLookup } from "./referenceSourcePathIdentity.js";

it("terminates ancestor lookup at relative and absolute fixed points", () => {
  const lookup = createReferenceSourcePathLookup(["dist"]);
  for (const path of ["..", "../..", ".", "/", ""]) {
    expect(lookup.resolveAncestor(path)).toBeUndefined();
  }
  expect(lookup.resolveAncestor("dist/nested/file.js")).toBe("dist");
  expect(lookup.resolveAncestor("dist-other/file.js")).toBeUndefined();
});

it("normalizes a deep ancestor query at most once", () => {
  const lookup = createReferenceSourcePathLookup(["dist"]);
  const path = `dist/${Array.from({ length: 128 }, (_, i) => `part${i}`).join("/")}`;
  const normalize = vi.spyOn(String.prototype, "normalize");
  let result: string | undefined;
  let calls: number;
  try {
    result = lookup.resolveAncestor(path);
    calls = normalize.mock.calls.length;
  } finally {
    normalize.mockRestore();
  }
  expect(result).toBe("dist");
  expect(calls).toBeLessThanOrEqual(1);
});

it("preserves exact spelling and ambiguity at the nearest recorded ancestor", () => {
  const lookup = createReferenceSourcePathLookup([
    "outer",
    "outer/Å",
    "outer/A\u030a",
  ]);
  expect(lookup.resolveAncestor("outer/A\u030a/child")).toBe("outer/A\u030a");
  expect(lookup.resolveAncestor("outer/\u212b/child")).toBeUndefined();
});
