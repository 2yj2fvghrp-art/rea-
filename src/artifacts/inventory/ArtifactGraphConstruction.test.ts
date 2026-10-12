import { describe, expect, it } from "vitest";

import {
  classifyArtifactBytes,
  classifyArtifactContent,
} from "./ArtifactGraphConstruction.js";

/** Minimal JVM class-file header: magic, minor/major version, cp count. */
const jvmClassPrefix = (major: number): Buffer => {
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32BE(0xcafebabe, 0);
  prefix.writeUInt16BE(0, 4);
  prefix.writeUInt16BE(major, 6);
  prefix.writeUInt16BE(2, 8);
  return prefix;
};

/** FAT Mach-O header with two architecture entries. */
const fatMachOPrefix = (nfatArch = 2): Buffer => {
  const prefix = Buffer.alloc(8 + nfatArch * 20);
  prefix.writeUInt32BE(0xcafebabe, 0);
  prefix.writeUInt32BE(nfatArch, 4);
  return prefix;
};

describe("classifyArtifactBytes", () => {
  it("does not label JVM class files as universal Mach-O", () => {
    expect(classifyArtifactBytes(jvmClassPrefix(65))).toBe("file");
    expect(classifyArtifactBytes(jvmClassPrefix(45))).toBe("file");
  });

  it("keeps labeling real FAT Mach-O headers as mach-o-universal", () => {
    expect(classifyArtifactBytes(fatMachOPrefix())).toBe("mach-o-universal");
    const swapped = fatMachOPrefix();
    swapped.writeUInt32BE(0xbebafeca, 0);
    expect(classifyArtifactBytes(swapped)).toBe("mach-o-universal");
    const fat64 = fatMachOPrefix();
    fat64.writeUInt32BE(0xcafebabf, 0);
    expect(classifyArtifactBytes(fat64)).toBe("mach-o-universal");
  });

  it("keeps the old label for non-class CA FE BA BE bytes", () => {
    const random = Buffer.alloc(16, 0);
    random.writeUInt32BE(0xcafebabe, 0);
    expect(classifyArtifactBytes(random)).toBe("mach-o-universal");
  });
});

describe("classifyArtifactContent", () => {
  it("does not mark class-file occurrences as executables", () => {
    const classified = classifyArtifactContent(
      "com/example/Hello.class",
      jvmClassPrefix(65),
    );
    expect(classified.format).not.toBe("mach-o-universal");
    expect(classified.kind).not.toBe("executable");
  });
});
