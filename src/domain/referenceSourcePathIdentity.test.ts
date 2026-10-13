import { expect, it } from "vitest";
import { createReferenceSourcePathLookup } from "./referenceSourcePathIdentity.js";

it("terminates ancestor lookup at relative and absolute fixed points", () => {
  const lookup = createReferenceSourcePathLookup(["dist"]);
  for (const path of ["..", "../..", ".", "/", ""]) {
    expect(lookup.resolveAncestor(path)).toBeUndefined();
  }
  expect(lookup.resolveAncestor("dist/nested/file.js")).toBe("dist");
  expect(lookup.resolveAncestor("dist-other/file.js")).toBeUndefined();
});
