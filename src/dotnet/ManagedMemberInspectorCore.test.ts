import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import {
  createDeclaringTypeLookup,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";

/** Reference first-match scan in metadata row order. */
const declaringType = (
  ranges: readonly TypeRange[],
  table: "field" | "method",
  row: number,
): { readonly token: string; readonly fullName: string | null } | null => {
  for (const range of ranges) {
    const start = table === "field" ? range.fieldStart : range.methodStart;
    const end = table === "field" ? range.fieldEnd : range.methodEnd;
    if (row >= start && row < end)
      return { token: range.token, fullName: range.fullName };
  }
  return null;
};

const range = (
  name: string,
  fieldStart: number,
  fieldEnd: number,
  methodStart = fieldStart,
  methodEnd = fieldEnd,
): TypeRange => ({
  token: name,
  fullName: name,
  fieldStart,
  fieldEnd,
  methodStart,
  methodEnd,
});

describe("managed declaring type ownership", () => {
  it("resolves field and method boundaries independently, including empty types and gaps", () => {
    const ranges = [
      range("first", 1, 3, 1, 1),
      range("empty", 3, 3, 1, 1),
      range("last", 5, 7, 1, 4),
    ];
    const field = createDeclaringTypeLookup(ranges, "field", 7);
    const method = createDeclaringTypeLookup(ranges, "method", 4);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(field)).toEqual([
      null,
      { token: "first", fullName: "first" },
      { token: "first", fullName: "first" },
      null,
      null,
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      null,
    ]);
    expect([0, 1, 2, 3, 4].map(method)).toEqual([
      null,
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      { token: "last", fullName: "last" },
      null,
    ]);
  });

  it("retains the first observed owner for overlapping, reversed, or out-of-order ranges", () => {
    const ranges = [
      range("first", 5, 9),
      range("overlap", 1, 7),
      range("reversed", 10, 2),
    ];
    const lookup = createDeclaringTypeLookup(ranges, "method", 10);
    expect(lookup(6)).toEqual({ token: "first", fullName: "first" });
    expect(lookup(2)).toEqual({ token: "overlap", fullName: "overlap" });
    expect(lookup(10)).toBeNull();
    expect(createDeclaringTypeLookup([], "method", 1)(1)).toBeNull();
  });

  it("resolves members of unordered ranges without rescanning every type", () => {
    // One reversed range makes the list unordered, and the owner comes last.
    // A per-member first-match scan took about 9 s at this size.
    const count = 100_000;
    const ranges = Array.from({ length: count }, (_, index) =>
      index === 0
        ? range("reversed", 1, 1, 2, 1)
        : index === count - 1
          ? range("owner", 1, 1, 1, count + 1)
          : range(`empty${String(index)}`, 1, 1, 1, 1),
    );
    const start = performance.now();
    const lookup = createDeclaringTypeLookup(ranges, "method", count);
    let owned = 0;
    for (let row = 1; row <= count; row += 1)
      if (lookup(row)?.token === "owner") owned += 1;
    expect(owned).toBe(count);
    expect(performance.now() - start).toBeLessThan(2000);
  }, 60_000);

  it.prop([
    fc.array(
      fc.record({
        fieldStart: fc.integer({ min: 0, max: 30 }),
        fieldEnd: fc.integer({ min: 0, max: 30 }),
        methodStart: fc.integer({ min: 0, max: 30 }),
        methodEnd: fc.integer({ min: 0, max: 30 }),
      }),
      { maxLength: 20 },
    ),
  ])(
    "agrees with observed first-match ownership for arbitrary metadata ranges",
    (raw) => {
      const ranges = raw.map((value, index) => ({
        ...value,
        token: String(index),
        fullName: `Type${String(index)}`,
      }));
      for (const table of ["field", "method"] as const) {
        const lookup = createDeclaringTypeLookup(ranges, table, 31);
        for (let row = 1; row <= 31; row += 1)
          expect(lookup(row)).toEqual(declaringType(ranges, table, row));
        // List positions are one-based; nothing else names a member.
        for (const row of [NaN, -Infinity, Infinity, 0, 32])
          expect(lookup(row)).toBeNull();
      }
    },
  );
});
