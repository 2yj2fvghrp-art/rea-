import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import { decodePeMachine } from "../domain/peMachine.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./ManagedReaderFailure.js";

interface PeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
}

interface PeDataDirectory {
  readonly rva: number;
  readonly size: number;
}

export interface ManagedCliHeader {
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly runtimeMajor: number;
  readonly runtimeMinor: number;
  readonly metadata: PeDataDirectory;
  readonly flags: number;
  readonly entryPoint: number;
  readonly resources: PeDataDirectory;
  readonly strongName: PeDataDirectory;
  readonly managedNativeHeader: PeDataDirectory;
  readonly readyToRunSignature: boolean;
}

/**
 * How the CLI header constrains process bitness. 32BITREQUIRED and
 * 32BITPREFERRED are one two-bit field: required alone is x86-only, both set
 * is platform-neutral code that prefers a 32-bit process, and preferred alone
 * is reserved and constrains nothing.
 */
export const managedCli32BitRequirement = (
  flags: number,
): "required" | "preferred" | "none" => {
  const pair = flags & 0x0002_0002;
  if (pair === 0x0000_0002) return "required";
  return pair === 0x0002_0002 ? "preferred" : "none";
};

export interface ManagedPeLayout {
  readonly machine: number;
  readonly architecture: "x86" | "x86_64" | "arm" | "arm64";
  readonly optionalHeader: "pe32" | "pe32-plus";
  readonly sectionCount: number;
  readonly characteristics: number;
  readonly sections: readonly PeSection[];
  readonly cli: ManagedCliHeader | null;
  readonly cliDirectoryState: "absent" | "present" | "unreadable";
  readonly cliIssue: ManagedParseIssue | null;
  rvaToOffset(rva: number, size: number, scope: string): number;
  rvaAvailableBytes(rva: number, scope: string): number;
}

/**
 * Disjoint intervals over the nonzero-virtual-size section extents. Each
 * interval records how many sections cover it (capped at two), the sole
 * covering section when unique, and the farthest end among covering sections,
 * so one binary search answers containment and ambiguity for any RVA range.
 */
interface SectionCoverage {
  readonly bounds: readonly number[];
  readonly counts: readonly number[];
  readonly owners: readonly (PeSection | null)[];
  readonly maxEnds: readonly number[];
  readonly starts: readonly number[];
}

interface RvaMapping {
  readonly bytes: Buffer;
  readonly coverage: SectionCoverage;
  readonly rva: number;
  readonly size: number;
  readonly scope: string;
}

interface CoffHeader {
  readonly coff: number;
  readonly machine: number;
  readonly sectionCount: number;
  readonly optionalSize: number;
  readonly characteristics: number;
}

interface OptionalHeader {
  readonly optionalOffset: number;
  readonly optionalHeader: "pe32" | "pe32-plus";
  readonly directoryCountOffset: number;
  readonly directoryOffset: number;
}

type CliDirectoryRead =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly directory: PeDataDirectory }
  | { readonly kind: "unreadable"; readonly issue: ManagedParseIssue };

const requireRange = (
  bytes: Buffer,
  offset: number,
  length: number,
  scope: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} leaves the artifact byte range`,
      Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
    );
};

const add = (left: number, right: number, scope: string): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} offset arithmetic overflowed`,
      left,
    );
  return result;
};

const architectureFor = (
  machine: number,
  managed: boolean,
): ManagedPeLayout["architecture"] => {
  const decoded = decodePeMachine(machine);
  if (decoded === undefined || (decoded.nativeOsOverride && !managed))
    throw managedFailure(
      "invalid-directory",
      "pe.machine",
      `Unsupported PE machine 0x${machine.toString(16).padStart(4, "0")}`,
    );
  return decoded.architecture;
};

/** Smallest index whose value exceeds the target in an ascending array. */
const upperBound = (values: readonly number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) <= target)
      low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Sweep the section extents once so each RVA lookup stays logarithmic. */
const buildSectionCoverage = (
  sections: readonly PeSection[],
): SectionCoverage => {
  const mapped = sections.filter((section) => section.virtualSize > 0);
  const sectionEnd = (section: PeSection): number =>
    section.virtualAddress + section.virtualSize;
  const byStart = [...mapped].sort(
    (left, right) => left.virtualAddress - right.virtualAddress,
  );
  const byEnd = [...mapped].sort(
    (left, right) => sectionEnd(left) - sectionEnd(right),
  );
  const bounds = [
    ...new Set(
      mapped.flatMap((section) => [
        section.virtualAddress,
        sectionEnd(section),
      ]),
    ),
  ].sort((left, right) => left - right);
  const counts: number[] = [];
  const owners: (PeSection | null)[] = [];
  const maxEnds: number[] = [];
  const active = new Set<PeSection>();
  // Ended sections never outrank an active one, so a running maximum suffices.
  let maxEnd = 0;
  let started = 0;
  let ended = 0;
  for (let interval = 0; interval + 1 < bounds.length; interval += 1) {
    const point = bounds[interval] ?? 0;
    for (let next = byEnd[ended]; next !== undefined; next = byEnd[ended]) {
      if (sectionEnd(next) > point) break;
      active.delete(next);
      ended += 1;
    }
    for (
      let next = byStart[started];
      next !== undefined;
      next = byStart[started]
    ) {
      if (next.virtualAddress > point) break;
      active.add(next);
      maxEnd = Math.max(maxEnd, sectionEnd(next));
      started += 1;
    }
    counts.push(Math.min(active.size, 2));
    owners.push(
      active.size === 1 ? (active.values().next().value ?? null) : null,
    );
    maxEnds.push(maxEnd);
  }
  return {
    bounds,
    counts,
    owners,
    maxEnds,
    starts: byStart.map((section) => section.virtualAddress),
  };
};

/** Resolve one section identity for both exact reads and available-byte queries. */
const resolveRva = (
  mapping: RvaMapping,
): { readonly offset: number; readonly available: number } => {
  const { bytes, coverage, rva, size, scope } = mapping;
  if (
    !Number.isSafeInteger(rva) ||
    !Number.isSafeInteger(size) ||
    rva < 0 ||
    size < 0 ||
    rva > 0xffff_ffff ||
    (size > 0 && size > 0x1_0000_0000 - rva)
  )
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} has an invalid RVA range`,
    );
  const notCovered = (): ManagedReaderFailure =>
    managedFailure(
      "invalid-directory",
      scope,
      `${scope} RVA is not covered by one PE section`,
    );
  const ambiguous = (): ManagedReaderFailure =>
    managedFailure(
      "invalid-directory",
      scope,
      `${scope} RVA range has ambiguous overlapping PE section mappings`,
    );
  // VirtualSize owns RVA containment; raw size also includes alignment padding.
  // A zero-size query claims one byte so containment and intersection agree.
  const rangeEnd = rva + Math.max(size, 1);
  const interval = upperBound(coverage.bounds, rva) - 1;
  const intervalEnd = coverage.bounds[interval + 1];
  if (
    interval < 0 ||
    intervalEnd === undefined ||
    coverage.counts[interval] === 0
  )
    throw notCovered();
  const selected = coverage.owners[interval] ?? null;
  if (selected === null)
    // Overlapping sections cover this RVA; the range is ambiguous when one of
    // them still contains it, and uncovered when none does.
    throw (coverage.maxEnds[interval] ?? 0) >= rangeEnd
      ? ambiguous()
      : notCovered();
  if (rangeEnd > selected.virtualAddress + selected.virtualSize)
    throw notCovered();
  if (rangeEnd > intervalEnd) throw ambiguous();
  const within = rva - selected.virtualAddress;
  if (within > selected.rawSize || size > selected.rawSize - within)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} occupies virtual bytes without file-backed data`,
    );
  const offset = add(selected.rawOffset, within, scope);
  requireRange(bytes, offset, size, scope);
  let available = Math.min(
    selected.virtualSize - within,
    selected.rawSize - within,
    bytes.length - offset,
    0x1_0000_0000 - rva,
  );
  // A future overlap ends the uniquely mapped extent even if the current byte is unique.
  const nextStart = coverage.starts[upperBound(coverage.starts, rva)];
  if (nextStart !== undefined) available = Math.min(available, nextStart - rva);
  return { offset, available };
};

const mapRva = (mapping: RvaMapping): number =>
  mapping.rva === 0 && mapping.size === 0 ? 0 : resolveRva(mapping).offset;

const readDirectory = (bytes: Buffer, offset: number): PeDataDirectory => {
  requireRange(bytes, offset, 8, "pe.data-directory");
  return {
    rva: bytes.readUInt32LE(offset),
    size: bytes.readUInt32LE(offset + 4),
  };
};

const readCliHeader = (
  bytes: Buffer,
  coverage: SectionCoverage,
  directory: PeDataDirectory,
): ManagedCliHeader => {
  if (directory.size < 72)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header is shorter than the required 72 bytes",
    );
  const offset = mapRva({
    bytes,
    coverage,
    rva: directory.rva,
    size: 72,
    scope: "cli.header",
  });
  const headerSize = bytes.readUInt32LE(offset);
  if (headerSize < 72 || headerSize > directory.size)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header size is outside its PE data directory",
      offset,
    );
  const metadata = readDirectory(bytes, offset + 8);
  if (metadata.rva === 0 || metadata.size === 0)
    throw managedFailure(
      "invalid-cli-header",
      "cli.metadata",
      "CLI metadata directory is absent",
      offset + 8,
    );
  const flags = bytes.readUInt32LE(offset + 16);
  const managedNativeHeader = readDirectory(bytes, offset + 64);
  let readyToRunSignature = false;
  if (managedNativeHeader.rva !== 0 && managedNativeHeader.size >= 4) {
    const nativeOffset = mapRva({
      bytes,
      coverage,
      rva: managedNativeHeader.rva,
      size: 4,
      scope: "cli.managed-native-header",
    });
    readyToRunSignature = bytes.readUInt32LE(nativeOffset) === 0x0052_5452;
  }
  return {
    headerOffset: offset,
    headerSize,
    runtimeMajor: bytes.readUInt16LE(offset + 4),
    runtimeMinor: bytes.readUInt16LE(offset + 6),
    metadata,
    flags,
    entryPoint: bytes.readUInt32LE(offset + 20),
    resources: readDirectory(bytes, offset + 24),
    strongName: readDirectory(bytes, offset + 32),
    managedNativeHeader,
    readyToRunSignature,
  };
};

const readCoffHeader = (bytes: Buffer): CoffHeader => {
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, "pe.coff-header");
  if (bytes.readUInt32LE(peOffset) !== 0x0000_4550)
    throw managedFailure(
      "invalid-directory",
      "pe.signature",
      "PE signature is invalid",
      peOffset,
    );
  const coff = peOffset + 4;
  const machine = bytes.readUInt16LE(coff);
  const sectionCount = bytes.readUInt16LE(coff + 2);
  if (sectionCount === 0)
    throw managedFailure(
      "invalid-directory",
      "pe.sections",
      "PE section count must be positive",
      coff + 2,
    );
  const optionalSize = bytes.readUInt16LE(coff + 16);
  const characteristics = bytes.readUInt16LE(coff + 18);
  return { coff, machine, sectionCount, optionalSize, characteristics };
};

const readOptionalHeader = (
  bytes: Buffer,
  coff: CoffHeader,
): OptionalHeader => {
  const optionalOffset = coff.coff + 20;
  requireRange(bytes, optionalOffset, coff.optionalSize, "pe.optional-header");
  if (coff.optionalSize < 96)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header is too short",
      optionalOffset,
    );
  const magic = bytes.readUInt16LE(optionalOffset);
  const optionalHeader =
    magic === 0x010b ? "pe32" : magic === 0x020b ? "pe32-plus" : undefined;
  if (optionalHeader === undefined)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header magic is unsupported",
      optionalOffset,
    );
  return {
    optionalOffset,
    optionalHeader,
    directoryCountOffset:
      optionalOffset + (optionalHeader === "pe32" ? 92 : 108),
    directoryOffset: optionalOffset + (optionalHeader === "pe32" ? 96 : 112),
  };
};

const readSections = (
  bytes: Buffer,
  coff: CoffHeader,
  optional: OptionalHeader,
): readonly PeSection[] => {
  const sectionOffset = add(
    optional.optionalOffset,
    coff.optionalSize,
    "pe.sections",
  );
  requireRange(bytes, sectionOffset, coff.sectionCount * 40, "pe.sections");
  const sections: PeSection[] = [];
  for (let index = 0; index < coff.sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    const section = {
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
    };
    if (section.rawSize > 0)
      requireRange(
        bytes,
        section.rawOffset,
        section.rawSize,
        "pe.section-data",
      );
    sections.push(section);
  }
  return sections;
};

const readCliDirectory = (
  bytes: Buffer,
  coff: CoffHeader,
  optional: OptionalHeader,
): CliDirectoryRead => {
  const countOffset = optional.directoryCountOffset - optional.optionalOffset;
  if (countOffset + 4 > coff.optionalSize)
    return {
      kind: "unreadable",
      issue: {
        code: "invalid-directory",
        scope: "pe.optional-header",
        detail: "PE optional header does not contain its directory count",
        offset: optional.directoryCountOffset,
      },
    };
  const directoryCount = bytes.readUInt32LE(optional.directoryCountOffset);
  if (directoryCount <= 14) return { kind: "absent" };
  const availableDirectoryCount = Math.floor(
    (coff.optionalSize - (optional.directoryOffset - optional.optionalOffset)) /
      8,
  );
  if (availableDirectoryCount < 15)
    return {
      kind: "unreadable",
      issue: {
        code: "invalid-directory",
        scope: "pe.data-directories",
        detail: "PE data-directory count exceeds the optional-header extent",
        offset: optional.directoryCountOffset,
      },
    };
  const directory = readDirectory(bytes, optional.directoryOffset + 14 * 8);
  return directory.rva !== 0 || directory.size !== 0
    ? { kind: "present", directory }
    : { kind: "absent" };
};

/** Parse the file-backed PE and CLI layout without loading target code. */
export const readManagedPeLayout = (bytes: Buffer): ManagedPeLayout => {
  requireRange(bytes, 0, 64, "pe.dos-header");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    throw managedFailure(
      "invalid-directory",
      "pe.dos-header",
      "Artifact does not start with an MZ header",
      0,
    );
  const coff = readCoffHeader(bytes);
  const optional = readOptionalHeader(bytes, coff);
  const sections = readSections(bytes, coff, optional);
  const coverage = buildSectionCoverage(sections);
  const cliDirectoryRead = readCliDirectory(bytes, coff, optional);
  const cliDirectoryState = cliDirectoryRead.kind;
  let cli: ManagedCliHeader | null = null;
  let cliIssue: ManagedParseIssue | null =
    cliDirectoryRead.kind === "unreadable" ? cliDirectoryRead.issue : null;
  if (cliDirectoryRead.kind === "present") {
    try {
      cli = readCliHeader(bytes, coverage, cliDirectoryRead.directory);
    } catch (cause: unknown) {
      if (!(cause instanceof ManagedReaderFailure)) throw cause;
      cliIssue = cause.issue;
    }
  }
  return {
    machine: coff.machine,
    architecture: architectureFor(coff.machine, cliDirectoryState !== "absent"),
    optionalHeader: optional.optionalHeader,
    sectionCount: coff.sectionCount,
    characteristics: coff.characteristics,
    sections,
    cli,
    cliDirectoryState,
    cliIssue,
    rvaToOffset: (rva, size, scope) =>
      mapRva({ bytes, coverage, rva, size, scope }),
    rvaAvailableBytes: (rva, scope) =>
      resolveRva({ bytes, coverage, rva, size: 1, scope }).available,
  };
};
