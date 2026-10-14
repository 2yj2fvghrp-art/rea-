import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import {
  buildManagedMemberPointerFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const inspect = (
  options: Parameters<typeof buildManagedMemberPointerFixture>[0] = {},
) => {
  const bytes = buildManagedMemberPointerFixture(options);
  return inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes));
};
const attributes = (
  options: Parameters<typeof buildManagedMemberPointerFixture>[0] = {},
) => inspect(options).attributes[0];

describe("signature-owned custom attribute arguments", () => {
  it.each([false, true])(
    "decodes a %s MemberRef constructor without a name allow-list",
    (attributeMemberRef) => {
      const result = attributes({ attributeMemberRef });
      expect(result).toMatchObject({
        constructor_token: attributeMemberRef ? "0x0a000001" : "0x06000001",
        decoded_fixed_string: null,
        arguments: {
          status: "decoded",
          reason: null,
          fixed: [
            {
              type: "string",
              value: "fixture",
              blob_offset: 2,
              status: "decoded",
              reason: null,
            },
          ],
          named: [],
        },
      });
      expect(result?.value_sha256).toBe(
        createHash("sha256")
          .update(Buffer.from("010007666978747572650000", "hex"))
          .digest("hex"),
      );
    },
  );
  it("retains named field/property, a null string and an empty string distinctly", () => {
    const attributeValue = Buffer.from(
      "0100ff0002005402034b65790153080843617061636974792a000000",
      "hex",
    );
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 2, 1, 14, 14]),
        attributeValue,
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { value: null, blob_offset: 2 },
        { value: "", blob_offset: 3 },
      ],
      named: [
        { kind: "property", name: "Key", type: "bool", value: true },
        { kind: "field", name: "Capacity", type: "int32", value: 42 },
      ],
    });
  });
  it("decodes System.Type, a boxed string, a string array and a null array", () => {
    const type = Buffer.from("System.String, Example.Assembly", "utf8");
    const attributeValue = Buffer.concat([
      Buffer.from([1, 0, type.length]),
      type,
      Buffer.from("0e05626f786564020000000161ffffffffff0000", "hex"),
    ]);
    expect(
      attributes({
        typeReferenceName: "Type",
        constructorSignature: Buffer.from([
          0x20, 4, 1, 0x12, 5, 28, 0x1d, 14, 0x1d, 14,
        ]),
        attributeValue,
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { type: "System.Type", value: type.toString() },
        { type: "object", value: { type: "string", value: "boxed" } },
        { type: "string[]", value: ["a", null] },
        { type: "string[]", value: null },
      ],
    });
  });
  it("preserves exact signed and unsigned 64-bit values", () => {
    const values = Buffer.alloc(16);
    values.writeBigInt64LE(-9223372036854775808n);
    values.writeBigUInt64LE(18446744073709551615n, 8);
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 2, 1, 10, 11]),
        attributeValue: Buffer.concat([
          Buffer.from([1, 0]),
          values,
          Buffer.from([0, 0]),
        ]),
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        { type: "int64", value: "-9223372036854775808" },
        { type: "uint64", value: "18446744073709551615" },
      ],
    });
  });
  it("derives a local enum width from its owned value__ field", () => {
    expect(
      attributes({
        methodPointers: null,
        fieldPointers: null,
        enumUnderlyingType: 5,
        constructorSignature: Buffer.from([0x20, 1, 1, 0x11, 12]),
        attributeValue: Buffer.from([1, 0, 2, 0, 0]),
      })?.arguments,
    ).toMatchObject({
      status: "decoded",
      fixed: [
        {
          type: "Fixture.B",
          value: 2,
          enum_underlying_type: { value: "uint8", kind: "derived" },
        },
      ],
    });
  });
  it("stops at an external enum without reading another assembly or guessing a width", () => {
    const result = attributes({
      constructorSignature: Buffer.from([0x20, 3, 1, 14, 0x11, 5, 14]),
      attributeValue: Buffer.from("010001780201790000", "hex"),
    });
    expect(result?.arguments).toMatchObject({
      status: "partial",
      reason: expect.stringContaining(
        "referenced assemblies were not inspected",
      ),
      fixed: [
        { type: "string", value: "x", status: "decoded" },
        { value: null, status: "unknown", blob_offset: 4 },
        { value: null, status: "unknown", blob_offset: null },
      ],
    });
  });
});

describe("attribute argument boundaries and unknowns", () => {
  it.each([
    ["prolog", "0200000000", "invalid custom attribute prolog"],
    ["truncation", "01000561", "truncated"],
    ["UTF-8", "010001ff0000", "invalid UTF-8"],
    ["trailing bytes", "010000000001", "trailing"],
  ])(
    "reports malformed %s without losing raw identity",
    (_name, hex, reason) => {
      const result = attributes({ attributeValue: Buffer.from(hex, "hex") });
      expect(result).toMatchObject({
        value_length: hex.length / 2,
        value_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        arguments: {
          status: "malformed",
          reason: expect.stringContaining(reason),
        },
      });
    },
  );
  it("rejects an impossible array count before allocation", () => {
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 1, 1, 0x1d, 14]),
        attributeValue: Buffer.from("0100feffffff0000", "hex"),
      })?.arguments,
    ).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("array count"),
    });
  });
  it("keeps generic and unresolved constructor shapes explicit", () => {
    expect(
      attributes({ constructorSignature: Buffer.from([0x20, 1, 1, 0x13, 0]) })
        ?.arguments,
    ).toMatchObject({ status: "unsupported", fixed: [{ status: "unknown" }] });
  });
  it.each([
    [2, "01", true],
    [3, "41d8", "\ud841"],
    [4, "80", -128],
    [5, "ff", 255],
    [6, "0080", -32768],
    [7, "ffff", 65535],
    [8, "00000080", -2147483648],
    [9, "ffffffff", 4294967295],
    [12, "0000c03f", 1.5],
    [13, "000000000000f03f", 1],
    [12, "0000807f", "Infinity"],
  ])(
    "retains element %i at its exact numeric boundary",
    (element, hex, value) => {
      const result = attributes({
        constructorSignature: Buffer.from([0x20, 1, 1, Number(element)]),
        attributeValue: Buffer.concat([
          Buffer.from([1, 0]),
          Buffer.from(String(hex), "hex"),
          Buffer.from([0, 0]),
        ]),
      });
      expect(result?.arguments).toMatchObject({
        status: "decoded",
        fixed: [{ value }],
      });
    },
  );
  it("represents an examined empty attribute compactly", () => {
    expect(
      attributes({
        constructorSignature: Buffer.from([0x20, 0, 1]),
        attributeValue: Buffer.from([1, 0, 0, 0]),
      })?.arguments,
    ).toBeNull();
  });
  it("bounds deeply nested parameter interpretation without overflowing the call stack", () => {
    const constructorSignature = Buffer.concat([
      Buffer.from([0x20, 1, 1]),
      Buffer.alloc(600, 0x1d),
      Buffer.from([14]),
    ]);
    expect(attributes({ constructorSignature })?.arguments).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("nesting capacity"),
    });
  });
});
