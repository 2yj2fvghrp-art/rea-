import { describe, expect, it } from "vitest";

import {
  MAX_TYPE_NESTING_DEPTH,
  nestedTypeDigests,
} from "./ManagedSignatureTypeNames.js";

/** Rows 1..length, each nested in the row before it. */
const chain = (length: number) => {
  const calls: number[] = [];
  const link = (row: number) => {
    calls.push(row);
    return row >= 1 && row <= length
      ? { name: `T${String(row)}`, enclosingRow: row > 1 ? row - 1 : null }
      : null;
  };
  return { calls, digest: nestedTypeDigests(link, () => undefined) };
};

describe("nested signature type digests", () => {
  it("reads each row of a chain within the nesting cap once", () => {
    const { calls, digest } = chain(MAX_TYPE_NESTING_DEPTH);
    for (let row = MAX_TYPE_NESTING_DEPTH; row >= 1; row -= 1)
      expect(digest(row)).toBeInstanceOf(Buffer);

    expect(calls).toHaveLength(MAX_TYPE_NESTING_DEPTH);
  });

  it("does not name a type nested deeper than the cap, and stops at the cap", () => {
    const { calls, digest } = chain(4_000);

    expect(digest(4_000)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(MAX_TYPE_NESTING_DEPTH + 1);
    expect(digest(MAX_TYPE_NESTING_DEPTH)).toBeInstanceOf(Buffer);
    expect(digest(MAX_TYPE_NESTING_DEPTH + 1)).toBeNull();
  });

  it("names every type of a long chain in linear time", () => {
    const { calls, digest } = chain(4_000);
    for (let row = 1; row <= 4_000; row += 1) digest(row);

    // Rows past the cap may each walk at most the cap; none rewalks below it.
    expect(calls.length).toBeLessThanOrEqual(
      4_000 * (MAX_TYPE_NESTING_DEPTH + 1),
    );
    expect(calls.filter((row) => row === 1)).toHaveLength(1);
  });

  it("does not name a type whose nesting is cyclic", () => {
    const digest = nestedTypeDigests(
      (row) => ({ name: `T${String(row)}`, enclosingRow: row === 1 ? 2 : 1 }),
      () => undefined,
    );

    expect(digest(1)).toBeNull();
    expect(digest(2)).toBeNull();
  });

  it("tells a nested type from a top-level type with its joined name", () => {
    const nested = nestedTypeDigests(
      (row) =>
        row === 1
          ? { name: "Outer", enclosingRow: null }
          : { name: "Inner", enclosingRow: 1 },
      () => undefined,
    );
    const flat = nestedTypeDigests(
      () => ({ name: "Outer/Inner", enclosingRow: null }),
      () => undefined,
    );

    expect(nested(2)).not.toEqual(flat(1));
  });
});
