import { describe, expect, it } from "vitest";

import { classifyArtifactBytes } from "./ArtifactGraphConstruction.js";

/**
 * A minimal JVM class header: 0xCAFEBABE, minor version, major version,
 * and a zeroed constant-pool count so only the first 8 bytes matter.
 */
const jvmClassPrefix = (major: number, minor = 0): Buffer =>
  Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    Buffer.from([(minor >> 8) & 0xff, minor & 0xff]),
    Buffer.from([(major >> 8) & 0xff, major & 0xff]),
    Buffer.from([0x00, 0x00]),
  ]);

/** A minimal big-endian FAT Mach-O header: magic, one architecture entry. */
const fatMachOPrefix = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // nfat_arch = 1
    Buffer.from([
      0x01,
      0x00,
      0x00,
      0x07, // cputype
      0x00,
      0x00,
      0x00,
      0x03, // cpusubtype
      0x00,
      0x00,
      0x10,
      0x00, // offset
      0x00,
      0x00,
      0x00,
      0x40, // size
      0x00,
      0x00,
      0x00,
      0x0c, // align
    ]),
  ]);

describe("classifyArtifactBytes disambiguates 0xCAFEBABE", () => {
  it("labels a JVM class file as a plain file, not a universal Mach-O", () => {
    expect(classifyArtifactBytes(jvmClassPrefix(65))).toBe("file");
  });

  it("labels a preview-release JVM class file as a plain file", () => {
    expect(classifyArtifactBytes(jvmClassPrefix(65, 0xffff))).toBe("file");
  });

  it("keeps a big-endian FAT Mach-O classified as a universal binary", () => {
    expect(classifyArtifactBytes(fatMachOPrefix())).toBe("mach-o-universal");
  });

  it("keeps byte-swapped universal binary magic classified as Mach-O", () => {
    expect(
      classifyArtifactBytes(Buffer.from([0xbe, 0xba, 0xfe, 0xca, 0, 0, 0, 1])),
    ).toBe("mach-o-universal");
  });
});
