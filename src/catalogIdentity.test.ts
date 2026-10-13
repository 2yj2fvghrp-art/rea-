import { describe, expect, it } from "vitest";

import { createCatalogDigests } from "./catalogIdentity.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import type { ToolContract } from "./contracts/toolContractTypes.js";

const findContract = (
  predicate: (c: ToolContract) => boolean,
): ToolContract => {
  const contract = TOOL_CONTRACTS.find(predicate);
  if (contract === undefined)
    throw new Error("no tool contract satisfies the test predicate");
  return contract;
};

const edited = (
  contract: ToolContract,
  changes: Partial<ToolContract>,
): readonly ToolContract[] =>
  TOOL_CONTRACTS.map((c) =>
    c.name === contract.name ? { ...c, ...changes } : c,
  );

describe("catalog digests cover what a client is advertised", () => {
  it("is stable across two computations of an unchanged catalog", () => {
    expect(createCatalogDigests()).toEqual(createCatalogDigests());
  });

  it("changes when a tool's advertised input examples change", () => {
    // The digest must cover the schema as advertised, not the canonical schema
    // it is projected from: dropping an example leaves validation untouched
    // while changing what the model is shown (#2578).
    const contract = findContract((c) => c.examples.length > 0);
    const withoutExamples = createCatalogDigests(
      edited(contract, { examples: [] }),
    );
    const baseline = createCatalogDigests();

    expect(withoutExamples.tools_sha256).not.toBe(baseline.tools_sha256);
    expect(withoutExamples.combined_sha256).not.toBe(baseline.combined_sha256);
  });

  it("still changes when returns_target_content changes", () => {
    // Control: an unrelated contract field the digest already covered must keep
    // affecting it, so the examples fix above cannot regress silently.
    const contract = findContract((c) => !c.returnsTargetContent);
    const flipped = createCatalogDigests(
      edited(contract, { returnsTargetContent: true }),
    );
    const baseline = createCatalogDigests();

    expect(flipped.tools_sha256).not.toBe(baseline.tools_sha256);
    expect(flipped.combined_sha256).not.toBe(baseline.combined_sha256);
  });
});
