import { Buffer } from "node:buffer";

/** Bounds-checked little-endian reader over one loaded buffer. */
class BoundedReader {
  constructor(private readonly bytes: Buffer) {}

  u8(offset: number): number | null {
    return offset < this.bytes.length ? this.bytes.readUInt8(offset) : null;
  }

  u16(offset: number): number | null {
    return offset + 2 <= this.bytes.length
      ? this.bytes.readUInt16LE(offset)
      : null;
  }

  u32(offset: number): number | null {
    return offset + 4 <= this.bytes.length
      ? this.bytes.readUInt32LE(offset)
      : null;
  }

  u64(offset: number): number | null {
    const low = this.u32(offset);
    const high = this.u32(offset + 4);
    if (low === null || high === null || high > 0x001fffff) return null;
    return high * 0x1_0000_0000 + low;
  }

  cString(offset: number, max: number): string | null {
    if (offset < 0 || offset >= this.bytes.length) return null;
    // Bound the terminator scan to the max name length plus one, so a
    // malformed symbol table cannot scan the entire image per entry.
    const limit = Math.min(this.bytes.length, offset + max + 1);
    const end = this.bytes.subarray(offset, limit).indexOf(0);
    if (end === -1 || end > max) return null;
    return this.bytes.subarray(offset, offset + end).toString("latin1");
  }
}

export interface ElfSymbol {
  readonly name: string;
  /** File offset mapped from the virtual address through PT_LOAD. */
  readonly offset: number;
  readonly size: number;
}

export interface ElfParseFailure {
  readonly reason: string;
}

const SHT_DYNSYM = 11;
const PT_LOAD = 1;

/**
 * Parse one snapshot symbol's file offset and size from a little-endian
 * ELF32 or ELF64 libapp.so image. Only the dynamic symbol table is walked;
 * every read is bounds-checked and any structural surprise is a refusal,
 * never a guess.
 */
export const readElfSymbol = (
  bytes: Buffer,
  symbolName: string,
): { symbol: ElfSymbol } | { failure: ElfParseFailure } => {
  const reader = new BoundedReader(bytes);
  const magic = reader.u32(0);
  if (magic !== 0x464c457f) return { failure: { reason: "not an ELF image" } };
  const elfClass = reader.u8(4);
  if (elfClass !== 1 && elfClass !== 2)
    return { failure: { reason: `unsupported ELF class ${String(elfClass)}` } };
  const is64 = elfClass === 2;
  const e_shoff = is64 ? reader.u64(0x28) : reader.u32(0x20);
  const e_shentsize = reader.u16(is64 ? 0x3a : 0x2e);
  const e_shnum = reader.u16(is64 ? 0x3c : 0x30);
  const e_phoff = is64 ? reader.u64(0x20) : reader.u32(0x1c);
  const e_phentsize = reader.u16(is64 ? 0x36 : 0x2a);
  const e_phnum = reader.u16(is64 ? 0x38 : 0x2c);
  const MIN_SHENT = is64 ? 64 : 40;
  if (
    e_shoff === null ||
    e_shentsize === null ||
    e_shnum === null ||
    e_shnum === 0 ||
    e_shentsize < MIN_SHENT ||
    e_shoff + e_shentsize * e_shnum > bytes.length
  )
    return {
      failure: {
        reason: "ELF section header table is missing or out of bounds",
      },
    };
  const MIN_PHENT = is64 ? 56 : 32;
  if (
    e_phoff === null ||
    e_phentsize === null ||
    e_phnum === null ||
    e_phentsize < MIN_PHENT ||
    e_phoff + e_phentsize * e_phnum > bytes.length
  )
    return {
      failure: {
        reason: "ELF program header table is missing or out of bounds",
      },
    };

  const segments: {
    readonly vaddr: number;
    readonly offset: number;
    readonly filesz: number;
  }[] = [];
  for (let index = 0; index < e_phnum; index += 1) {
    const base = e_phoff + index * e_phentsize;
    const type = reader.u32(base);
    if (type !== PT_LOAD) continue;
    const vaddr = is64 ? reader.u64(base + 0x10) : reader.u32(base + 8);
    const offset = is64 ? reader.u64(base + 0x08) : reader.u32(base + 4);
    const filesz = is64 ? reader.u64(base + 0x20) : reader.u32(base + 0x10);
    if (vaddr === null || offset === null || filesz === null)
      return {
        failure: { reason: `PT_LOAD segment ${String(index)} is truncated` },
      };
    segments.push({ vaddr, offset, filesz });
  }
  if (segments.length === 0)
    return { failure: { reason: "ELF image has no PT_LOAD segments" } };
  const toOffset = (vaddr: number, size: number): number | null => {
    let best: {
      vaddr: number;
      offset: number;
      filesz: number;
    } | null = null;
    for (const segment of segments)
      if (
        segment.vaddr <= vaddr &&
        (best === null || segment.vaddr > best.vaddr)
      )
        best = segment;
    if (best === null) return null;
    const delta = vaddr - best.vaddr;
    // The full symbol must sit inside the file-backed portion of the
    // segment; addresses in a gap or BSS are not snapshot bytes.
    if (delta + size > best.filesz) return null;
    return best.offset + delta;
  };

  for (let index = 0; index < e_shnum; index += 1) {
    const header = e_shoff + index * e_shentsize;
    const type = reader.u32(is64 ? header + 4 : header + 4);
    if (type !== SHT_DYNSYM) continue;
    const offset = is64 ? reader.u64(header + 0x18) : reader.u32(header + 0x10);
    const size = is64 ? reader.u64(header + 0x20) : reader.u32(header + 0x14);
    const link = reader.u32(is64 ? header + 0x28 : header + 0x18);
    if (offset === null || size === null)
      return { failure: { reason: "dynamic symbol table is truncated" } };
    const entrySize = is64 ? 24 : 16;
    if (offset + size > bytes.length || size % entrySize !== 0)
      return { failure: { reason: "dynamic symbol table is malformed" } };
    if (link === null || link >= e_shnum)
      return {
        failure: {
          reason: "dynamic symbol table string section link is invalid",
        },
      };
    const stringHeader = e_shoff + link * e_shentsize;
    const stringOffset = is64
      ? reader.u64(stringHeader + 0x18)
      : reader.u32(stringHeader + 0x10);
    const stringSize = is64
      ? reader.u64(stringHeader + 0x20)
      : reader.u32(stringHeader + 0x14);
    if (
      stringOffset === null ||
      stringSize === null ||
      stringOffset + stringSize > bytes.length
    )
      return {
        failure: { reason: "dynamic symbol strings are out of bounds" },
      };
    for (let entry = 0; entry < size / entrySize; entry += 1) {
      const base = offset + entry * entrySize;
      const nameOffset = reader.u32(base);
      const stValue = is64 ? reader.u64(base + 8) : reader.u32(base + 4);
      const stSize = is64 ? reader.u64(base + 16) : reader.u32(base + 8);
      if (nameOffset === null || stValue === null || stSize === null) continue;
      const name = reader.cString(stringOffset + nameOffset, 256);
      if (name !== symbolName) continue;
      const fileOffset = toOffset(stValue, stSize);
      if (fileOffset === null)
        return {
          failure: { reason: `symbol ${symbolName} has no loadable address` },
        };
      if (fileOffset + stSize > bytes.length)
        return {
          failure: { reason: `symbol ${symbolName} extends past the image` },
        };
      return { symbol: { name, offset: fileOffset, size: stSize } };
    }
  }
  return {
    failure: {
      reason: `symbol ${symbolName} is not in the dynamic symbol table`,
    },
  };
};

/** Read one Dart snapshot section header from its file offset. */
export const readSnapshotHeader = (
  bytes: Buffer,
  offset: number,
): {
  magicValid: boolean;
  kind: number | null;
  headerLength: number | null;
} => {
  const reader = new BoundedReader(bytes);
  // The Dart magic bytes f5 f5 dc dc read little-endian. Kind and length
  // fields are only meaningful in data-section headers; sections without
  // the magic (instructions carry a different layout) report nulls.
  const magic = reader.u32(offset);
  if (magic !== 0xdcdcf5f5)
    return { magicValid: false, kind: null, headerLength: null };
  const headerLength = reader.u64(offset + 4);
  const kind = reader.u32(offset + 12);
  return { magicValid: true, kind, headerLength };
};

export const buildElf64Image = (
  symbols: ReadonlyArray<{ name: string; value: number; size: number }>,
): Buffer => {
  const ELF_HEADER = 64;
  const PHENT = 56;
  const PHNUM = 1;
  const SHENT = 64;
  const phoff = ELF_HEADER;
  const shoffAligned = phoff + PHENT * PHNUM;
  // Place payload data after the three section headers so nothing overlaps.
  const dynsymOff = shoffAligned + 3 * SHENT + 16;
  const dynstrOff = dynsymOff + symbols.length * 24;
  const image = Buffer.alloc(dynstrOff + 256);
  // ELF header
  image.writeUInt32LE(0x464c457f, 0);
  image[4] = 2; // ELFCLASS64
  image[5] = 1; // little-endian
  image.writeUInt16LE(0x003e, 0x12); // e_machine x86_64
  image.writeUInt32LE(1, 0x10); // ET_REL? keep type small
  image.writeBigUInt64LE(BigInt(phoff), 0x20);
  image.writeBigUInt64LE(BigInt(shoffAligned), 0x28);
  image.writeUInt16LE(PHENT, 0x36);
  image.writeUInt16LE(PHNUM, 0x38);
  image.writeUInt16LE(SHENT, 0x3a);
  image.writeUInt16LE(2, 0x3c); // e_shnum: null + dynsym
  // Program header: one PT_LOAD mapping identity
  const ph = phoff;
  image.writeUInt32LE(1, ph); // PT_LOAD
  image.writeBigUInt64LE(BigInt(0), ph + 8); // offset
  image.writeBigUInt64LE(BigInt(0), ph + 0x10); // vaddr
  image.writeBigUInt64LE(BigInt(0x10000), ph + 0x20); // p_filesz generously covers fixture symbols
  // Section headers
  const sh = shoffAligned;
  // null section stays zero
  const dyn = sh + SHENT;
  image.writeUInt32LE(11, dyn + 4); // SHT_DYNSYM
  image.writeBigUInt64LE(BigInt(dynsymOff), dyn + 0x18);
  image.writeBigUInt64LE(BigInt(symbols.length * 24), dyn + 0x20);
  image.writeUInt32LE(2, dyn + 0x28); // sh_link -> strtab section index
  // dynstr section header
  const str = dyn + SHENT;
  image.writeUInt32LE(3, str + 4); // SHT_STRTAB
  image.writeBigUInt64LE(BigInt(dynstrOff), str + 0x18);
  image.writeBigUInt64LE(BigInt(256), str + 0x20);
  image.writeUInt16LE(3, 0x3c); // e_shnum includes strtab
  // dynstr: leading NUL then names
  let strCursor = dynstrOff + 1;
  const nameOffsets = symbols.map((symbol) => {
    image.write(symbol.name, strCursor, "latin1");
    const at = strCursor - dynstrOff;
    strCursor += symbol.name.length + 1;
    return at;
  });
  // dynsym entries
  symbols.forEach((symbol, index) => {
    const base = dynsymOff + index * 24;
    image.writeUInt32LE(nameOffsets[index]!, base);
    image.writeBigUInt64LE(BigInt(symbol.value), base + 8);
    image.writeBigUInt64LE(BigInt(symbol.size), base + 16);
    image[base + 4] = 0x10; // GLOBAL FUNC
  });
  return image;
};

/** A minimal Dart snapshot data section carrying a 32-hex hash. */
export const snapshotSection = (hash: string): Buffer =>
  Buffer.concat([
    Buffer.from([
      0xf5, 0xf5, 0xdc, 0xdc, 0x49, 0x0d, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0,
      0,
    ]),
    Buffer.from(hash, "latin1"),
  ]);
