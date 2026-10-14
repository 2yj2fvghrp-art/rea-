import { describe, expect, it } from "vitest";
import { macDeveloperIdRequirement } from "../../../src/process/MacCodeSignature.js";

describe("macDeveloperIdRequirement", () => {
  it("formats valid bundle and team identifiers into Apple codesign requirements", () => {
    const requirement = macDeveloperIdRequirement(
      "com.cryptic-apps.hopper-web-4",
      "2AMA2753NF",
    );
    expect(requirement).toBe(
      '= identifier "com.cryptic-apps.hopper-web-4" and anchor apple generic and certificate leaf[subject.OU] = "2AMA2753NF"',
    );
  });

  it("rejects identifiers containing injection characters or whitespace", () => {
    expect(() =>
      macDeveloperIdRequirement('evil" or anchor apple', "2AMA2753NF"),
    ).toThrow(TypeError);
    expect(() =>
      macDeveloperIdRequirement("hopper", 'evil" or anchor apple'),
    ).toThrow(TypeError);
    expect(() => macDeveloperIdRequirement("app name", "2AMA2753NF")).toThrow(
      TypeError,
    );
  });
});
