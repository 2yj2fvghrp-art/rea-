import { describe, expect, it } from "vitest";

import { admitManagedProjection } from "./ManagedDecodeBudget.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

describe("managed projection admission", () => {
  it("charges decoded strings by their JSON bytes", () => {
    const name = "a".repeat(12 * 1024 * 1024);

    expect(admitManagedProjection({ name })).toEqual({ name });
  });

  it("charges escaped and multibyte characters at their encoded size", () => {
    expect(() =>
      admitManagedProjection({ name: "\u0001".repeat(12 * 1024 * 1024) }),
    ).toThrow(ManagedReaderFailure);
    expect(() =>
      admitManagedProjection({ name: "€".repeat(23 * 1024 * 1024) }),
    ).toThrow(ManagedReaderFailure);
  });
});
