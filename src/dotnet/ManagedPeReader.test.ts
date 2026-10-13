import { describe, expect, it } from "vitest";

import { readManagedPeLayout } from "./ManagedPeReader.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

interface RawPeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
}

const PE_OFFSET = 64;
const OPTIONAL_SIZE = 96;
const SECTION_TABLE = PE_OFFSET + 4 + 20 + OPTIONAL_SIZE;

/** Build a minimal PE32 image without a CLI directory from raw section rows. */
const rawPeLayout = (sections: readonly RawPeSection[], fileSize?: number) => {
  const headerEnd = SECTION_TABLE + sections.length * 40;
  const bytes = Buffer.alloc(
    fileSize ??
      Math.max(
        headerEnd,
        ...sections.map((section) => section.rawOffset + section.rawSize),
      ),
  );
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(PE_OFFSET, 0x3c);
  bytes.writeUInt32LE(0x0000_4550, PE_OFFSET);
  const coff = PE_OFFSET + 4;
  bytes.writeUInt16LE(0x8664, coff);
  bytes.writeUInt16LE(sections.length, coff + 2);
  bytes.writeUInt16LE(OPTIONAL_SIZE, coff + 16);
  const optionalOffset = coff + 20;
  bytes.writeUInt16LE(0x010b, optionalOffset);
  sections.forEach((section, index) => {
    const offset = SECTION_TABLE + index * 40;
    bytes.writeUInt32LE(section.virtualSize, offset + 8);
    bytes.writeUInt32LE(section.virtualAddress, offset + 12);
    bytes.writeUInt32LE(section.rawSize, offset + 16);
    bytes.writeUInt32LE(section.rawOffset, offset + 20);
  });
  return readManagedPeLayout(bytes);
};

describe("managed PE RVA resolution", () => {
  const plain: readonly RawPeSection[] = [
    {
      virtualAddress: 0x1000,
      virtualSize: 0x100,
      rawOffset: 0x200,
      rawSize: 0x80,
    },
    {
      virtualAddress: 0x2000,
      virtualSize: 0x100,
      rawOffset: 0x400,
      rawSize: 0x100,
    },
  ];

  it("maps an RVA inside one file-backed section", () => {
    const layout = rawPeLayout(plain);
    expect(layout.rvaToOffset(0x1010, 0x10, "test")).toBe(0x210);
    expect(layout.rvaToOffset(0x2000, 0x100, "test")).toBe(0x400);
    expect(layout.rvaToOffset(0, 0, "test")).toBe(0);
  });

  it("reports available bytes bounded by the raw extent", () => {
    const layout = rawPeLayout(plain);
    expect(layout.rvaAvailableBytes(0x1010, "test")).toBe(0x70);
  });

  it("rejects an RVA no section covers", () => {
    const layout = rawPeLayout(plain);
    expect(() => layout.rvaToOffset(0x1800, 4, "test")).toThrow(
      ManagedReaderFailure,
    );
    expect(() => layout.rvaToOffset(0x1800, 4, "test")).toThrow(
      /not covered by one PE section/,
    );
  });

  it("rejects a range that leaves its only covering section", () => {
    const layout = rawPeLayout(plain);
    expect(() => layout.rvaToOffset(0x10f8, 0x10, "test")).toThrow(
      /not covered by one PE section/,
    );
  });

  it("rejects virtual-only bytes without file backing", () => {
    const layout = rawPeLayout(plain);
    expect(() => layout.rvaToOffset(0x1090, 4, "test")).toThrow(
      /occupies virtual bytes without file-backed data/,
    );
  });

  const overlapping: readonly RawPeSection[] = [
    {
      virtualAddress: 0x1000,
      virtualSize: 0x200,
      rawOffset: 0x200,
      rawSize: 0x200,
    },
    {
      virtualAddress: 0x1100,
      virtualSize: 0x100,
      rawOffset: 0x600,
      rawSize: 0x100,
    },
  ];

  it("rejects ranges touching ambiguous overlapping section mappings", () => {
    const layout = rawPeLayout(overlapping);
    expect(() => layout.rvaToOffset(0x1120, 4, "test")).toThrow(
      /ambiguous overlapping PE section mappings/,
    );
    expect(() => layout.rvaToOffset(0x10f0, 0x20, "test")).toThrow(
      /ambiguous overlapping PE section mappings/,
    );
  });

  it("still maps the uniquely covered extent of an overlapping section", () => {
    const layout = rawPeLayout(overlapping);
    expect(layout.rvaToOffset(0x1020, 4, "test")).toBe(0x220);
  });

  it("ends available bytes where the next section mapping begins", () => {
    const layout = rawPeLayout(overlapping);
    expect(layout.rvaAvailableBytes(0x1020, "test")).toBe(0xe0);
  });

  it("ignores sections without virtual bytes", () => {
    const layout = rawPeLayout([
      ...plain,
      { virtualAddress: 0x1010, virtualSize: 0, rawOffset: 0, rawSize: 0 },
    ]);
    expect(layout.rvaToOffset(0x1010, 4, "test")).toBe(0x210);
  });

  it("resolves RVAs against the maximum section count within bounded time", () => {
    const count = 0xffff;
    const headerEnd = SECTION_TABLE + count * 40;
    const sections = Array.from({ length: count }, (_, index) => ({
      virtualAddress: 0x1000 * (index + 1),
      virtualSize: 0x10,
      rawOffset: headerEnd,
      rawSize: 0x10,
    }));
    const layout = rawPeLayout(sections, headerEnd + 0x10);
    const start = performance.now();
    for (let lookup = 0; lookup < 20000; lookup += 1) {
      const index = (lookup * 2654435761) % count;
      const rva = 0x1000 * (index + 1);
      expect(layout.rvaToOffset(rva, 8, "test")).toBe(headerEnd);
      expect(layout.rvaAvailableBytes(rva, "test")).toBe(0x10);
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
