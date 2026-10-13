import {
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
  type GoImageSection,
} from "../go/GoBinaryContainer.js";
import { readGoBinaryContainer } from "../go/GoBinaryImage.js";
import type {
  RustAuditableMetadata,
  RustBinary,
} from "../domain/rust/rustBinary.js";
import {
  readAuditableSection,
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";

const RUSTC_PREFIX = Buffer.from("/rustc/");
const HASH_BYTES = 40;

/** Container identity plus optional dependency metadata and inferred rustc commits. */
export interface RustBinaryImage {
  readonly format: RustBinary["format"];
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: RustBinary["byte_order"];
  readonly auditable_metadata: RustAuditableMetadata | null;
  readonly rustc_commit: RustBinary["rustc_commit"];
}

/** Read dependency metadata from container sections without executing the image. */
export const readRustBinaryImage = (bytes: Buffer): RustBinaryImage => {
  const container = readContainer(bytes);
  const dependency = dependencySection(container.format, container.sections);
  return {
    format: container.format,
    architecture: container.architecture,
    bits: container.bits,
    byte_order: container.byte_order,
    auditable_metadata:
      dependency === null
        ? null
        : readDependency(bytes, container.format, dependency),
    rustc_commit: rustcCommit(bytes, container.sections),
  };
};

const readContainer = (bytes: Buffer) => {
  try {
    return readGoBinaryContainer(bytes);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure)
      throw new RustAuditableFormatFailure(cause.kind, cause.message, {
        cause,
      });
    if (cause instanceof GoBinaryResourceFailure)
      throw new RustAuditableResourceFailure(
        cause.maximum_bytes,
        cause.message,
        {
          cause,
        },
      );
    throw cause;
  }
};

const dependencySection = (
  format: RustBinaryImage["format"],
  sections: readonly GoImageSection[],
): GoImageSection | null => {
  const expected = format === "macho" ? "__DATA,.dep-v0" : ".dep-v0";
  const matches = sections.filter((section) => section.name === expected);
  if (matches.length > 1)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Image contains more than one dependency section",
    );
  const section = matches[0];
  if (section === undefined) return null;
  if (section.compressed)
    throw new RustAuditableFormatFailure(
      "unsupported",
      "Compressed dependency sections are unsupported",
    );
  if (!section.file_backed)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is not file-backed",
    );
  return section;
};

const readDependency = (
  bytes: Buffer,
  format: RustBinaryImage["format"],
  section: GoImageSection,
): RustAuditableMetadata =>
  readAuditableSection(
    format === "macho" ? "__DATA,.dep-v0" : ".dep-v0",
    section.offset,
    bytes.subarray(section.offset, section.offset + section.size),
  );

const rustcCommit = (
  bytes: Buffer,
  sections: readonly GoImageSection[],
): RustBinaryImage["rustc_commit"] => {
  const hashes: { hash: string; file_offset: number }[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (!section.read_only) continue;
    collectHashes(bytes, section, seen, hashes);
  }
  return hashes.length === 0 ? null : { evidence_kind: "inferred", hashes };
};

const collectHashes = (
  bytes: Buffer,
  section: GoImageSection,
  seen: Set<string>,
  hashes: { hash: string; file_offset: number }[],
): void => {
  const region = bytes.subarray(section.offset, section.offset + section.size);
  let cursor = 0;
  while (cursor < region.length) {
    const at = region.indexOf(RUSTC_PREFIX, cursor);
    if (at < 0) return;
    const start = at + RUSTC_PREFIX.length;
    const hash = hashAt(region, start);
    if (hash !== null && !seen.has(hash)) {
      seen.add(hash);
      hashes.push({ hash, file_offset: section.offset + at });
    }
    cursor = at + 1;
  }
};

const hashAt = (region: Buffer, start: number): string | null => {
  const end = start + HASH_BYTES;
  if (end >= region.length || region[end] !== 0x2f) return null;
  for (let index = start; index < end; index += 1) {
    const byte = region[index] ?? 0;
    const hex =
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
    if (!hex) return null;
  }
  return region.toString("latin1", start, end);
};
