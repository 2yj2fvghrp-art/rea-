import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  attachManagedDecodeBudget,
  ManagedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { signature } from "./ManagedMemberInspectorCore.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import { signatureTypeNames } from "./ManagedSignatureTypeNames.js";

const nameDigest = (name: string): Buffer =>
  createHash("sha256").update(name).digest();

const named =
  (names: Readonly<Record<number, string>>) =>
  (codedIndex: number): Buffer | null => {
    const name = names[codedIndex];
    return name === undefined ? null : nameDigest(name);
  };

describe("resolved member signature digests", () => {
  it("names modifier, class, and generic type operands instead of their rows", () => {
    // modreq(M) G<P> on the left and the same types at other rows on the right.
    const left = signature(
      Buffer.from([0x06, 0x1f, 0x05, 0x15, 0x12, 0x09, 0x01, 0x11, 0x0d]),
      undefined,
      named({ 0x05: "N.Mod", 0x09: "N.G`1", 0x0d: "N.P" }),
    );
    const right = signature(
      Buffer.from([0x06, 0x1f, 0x15, 0x15, 0x12, 0x19, 0x01, 0x11, 0x1d]),
      undefined,
      named({ 0x15: "N.Mod", 0x19: "N.G`1", 0x1d: "N.P" }),
    );

    expect(left.raw_sha256).not.toBe(right.raw_sha256);
    expect(left.resolved_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(left.resolved_sha256).toBe(right.resolved_sha256);
  });

  it("keeps the raw digest for a signature without type operands", () => {
    const decoded = signature(Buffer.from([0x00, 0x01, 0x08, 0x0e]));

    expect(decoded.resolved_sha256).toBe(decoded.raw_sha256);
  });

  it("withholds the digest when an operand has no name", () => {
    expect(
      signature(Buffer.from([0x06, 0x12, 0x05]), undefined, named({}))
        .resolved_sha256,
    ).toBeNull();
  });

  it("cannot reproduce another signature's raw bytes", () => {
    // Without the 0xff marker, class "A" would hash as these raw bytes.
    const raw = signature(
      Buffer.concat([Buffer.from([0x06, 0x12]), nameDigest("A")]),
    );
    const resolved = signature(
      Buffer.from([0x06, 0x12, 0x05]),
      undefined,
      named({ 0x05: "A" }),
    );

    expect(raw.resolved_sha256).toBeNull();
    expect(resolved.resolved_sha256).not.toBe(raw.raw_sha256);
  });

  it.each([
    ["a TypeSpec, whose blob member inspection does not decode", (1 << 2) | 2],
    ["a TypeRef row outside its table", (9 << 2) | 1],
  ])("does not name %s", (_name, codedIndex) => {
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.from([0x06, 0x12, codedIndex]),
    });
    const field = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    ).fields[0];

    expect(field?.signature.parse_status).toBe("decoded");
    expect(field?.signature.resolved_sha256).toBeNull();
  });

  it("names each type operand once, so repeated operands are not charged again", () => {
    const bytes = buildManagedPeFixture({
      typeReferences: [{ namespace: "System", name: "Uri" }],
    });
    const pe = readManagedPeLayout(bytes);
    if (pe.cli === null) throw new Error("Fixture has no CLI metadata");
    const layout = readManagedMetadataLayout(
      bytes,
      pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
      pe.cli.metadata.size,
    );
    const budget = new ManagedDecodeBudget();
    attachManagedDecodeBudget(layout, budget);
    const typeName = signatureTypeNames(bytes, layout, []);
    const uri = (2 << 2) | 1;

    expect(typeName(uri)).toEqual(nameDigest("System.Uri"));
    const reserve = vi.spyOn(budget, "reserve");
    expect(typeName(uri)).toEqual(nameDigest("System.Uri"));
    expect(reserve).not.toHaveBeenCalled();
  });
});
