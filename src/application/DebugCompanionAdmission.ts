import { createHash } from "node:crypto";
import { constants, type Dir, type Stats } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FileHandle } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result.js";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import type {
  BinaryArchitecture,
  MachODebugCompanion,
  UniversalMachOSlice,
} from "../domain/binaryTargetTypes.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  debugCompanionMatches,
  machoUuidReads,
  type MachOImageUuid,
} from "../domain/machoDebugCompanion.js";

/**
 * Per-slice UUID observation: null marks a slice that declared no LC_UUID,
 * so family selection can honor the earlier slice instead of skipping it.
 */
export type SliceUuidEntry = MachOImageUuid;

/** Keep workflow resource refusal distinct from malformed candidate data. */
interface MachOUuidReadFailure {
  readonly kind: "resource-limit" | "invalid-image";
  readonly reason: string;
}

const resourceLimit = (reason: string): MachOUuidReadFailure => ({
  kind: "resource-limit",
  reason,
});
const invalidImage = (reason: string): MachOUuidReadFailure => ({
  kind: "invalid-image",
  reason,
});

/** Bound on the bytes read to walk Mach-O headers and load commands. */
const HEADER_READ_LIMIT = 64 * 1024;

/** A real dSYM bundle carries one DWARF member per architecture; more is noise. */
const MEMBER_COUNT_LIMIT = 16;

/**
 * Member size admitted for hashing and staging. Real members scale with their
 * executable; one gibibyte covers shipped-app dSYMs while bounding private
 * runtime disk use before any copy starts.
 */
const MEMBER_SIZE_LIMIT_BYTES = 1024 * 1024 * 1024;

const DSYM_DWARF_DIRECTORY = join("Contents", "Resources", "DWARF");

/**
 * Mach-O cputypes for the provider-neutral CPU families REA admits, including
 * the 64-bit flag the ABI sets on x86_64 and arm64. MIPS has no Mach-O
 * cputype; a companion can never match it.
 */
const CPU_TYPES: Readonly<Record<BinaryArchitecture, readonly number[]>> = {
  x86: [0x00000007],
  x86_64: [0x01000007],
  arm: [0x0000000c],
  arm64: [0x0100000c],
  mips: [],
  // RISCV has no Mach-O cputype in REA's header families; it is ELF-only.
  riscv: [],
};

/** Admitted identity of a caller-selected dSYM companion. */
export type DebugCompanionAdmission = Result<
  MachODebugCompanion,
  DebugCompanionRejection
>;

/** Why a caller-selected debug companion was refused, in caller-facing words. */
export interface DebugCompanionRejection {
  readonly reason: string;
}

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("resolve_binary_target");
};

/** Read a bounded window, charging actual I/O and observing cancellation. */
const readUuidWindow = async (
  handle: FileHandle,
  offset: number,
  length: number,
  ledger: TraversalLedger,
  signal: AbortSignal | undefined,
): Promise<Result<Buffer, MachOUuidReadFailure>> => {
  throwIfCancelled(signal);
  if (length > TRAVERSAL_BUDGET_BYTES - ledger.spent)
    return err(
      resourceLimit(
        "the Mach-O traversal exceeds the supported aggregate budget",
      ),
    );
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    throwIfCancelled(signal);
    const observed = await handle.read(
      bytes,
      filled,
      length - filled,
      offset + filled,
    );
    throwIfCancelled(signal);
    const charged = chargeTraversal(ledger, observed.bytesRead);
    if (!charged.ok) return charged;
    if (observed.bytesRead === 0) break;
    filled += observed.bytesRead;
  }
  return ok(bytes.subarray(0, filled));
};

/** Drive the shared format decoder with one bounded cached window per image. */
const readThinUuidEntry = async (
  handle: FileHandle,
  offset: number,
  length: number,
  ledger: TraversalLedger,
  signal: AbortSignal | undefined,
  prefix?: Buffer,
): Promise<Result<MachOImageUuid, MachOUuidReadFailure>> => {
  const decoder = machoUuidReads(length);
  let step = decoder.next();
  let windowOffset = 0;
  let window = prefix ?? Buffer.alloc(0);
  while (!step.done) {
    throwIfCancelled(signal);
    const request = step.value;
    if (
      request.offset < windowOffset ||
      request.offset + request.length > windowOffset + window.length
    ) {
      const windowLength = Math.min(
        HEADER_READ_LIMIT,
        length - request.offset,
        TRAVERSAL_BUDGET_BYTES - ledger.spent,
      );
      if (windowLength < request.length)
        return err(
          resourceLimit(
            "the Mach-O traversal exceeds the supported aggregate budget",
          ),
        );
      const read = await readUuidWindow(
        handle,
        offset + request.offset,
        windowLength,
        ledger,
        signal,
      );
      if (!read.ok) return read;
      windowOffset = request.offset;
      window = read.value;
    }
    const start = request.offset - windowOffset;
    step = decoder.next(window.subarray(start, start + request.length));
  }
  return step.value.ok ? step.value : err(invalidImage(step.value.error));
};

/**
 * Aggregate bytes one admission may spend reading Mach-O headers and load
 * commands across the target and every member candidate. Only bytes actually
 * read are charged, and the ledger is shared for the whole admission.
 */
const TRAVERSAL_BUDGET_BYTES = 64 * 1024 * 1024;

interface TraversalLedger {
  spent: number;
}

const chargeTraversal = (
  ledger: TraversalLedger,
  bytes: number,
): Result<null, MachOUuidReadFailure> => {
  ledger.spent += bytes;
  return ledger.spent > TRAVERSAL_BUDGET_BYTES
    ? err(
        resourceLimit(
          "the Mach-O traversal exceeds the supported aggregate budget",
        ),
      )
    : ok(null);
};

/**
 * Read every LC_UUID of a Mach-O file with its declaring cputype: a thin
 * image from its start, or each slice of a universal container from its
 * table (a UUID-less slice keeps its place as a null entry). Cancellation
 * and the aggregate traversal budget are honored between slices.
 */
export const readMachoFileUuidEntries = async (
  handle: FileHandle,
  fileSize: number,
  options: {
    readonly signal?: AbortSignal;
    readonly ledger?: TraversalLedger;
  } = {},
): Promise<Result<SliceUuidEntry[], MachOUuidReadFailure>> => {
  const ledger = options.ledger ?? { spent: 0 };
  const signal = options.signal;
  const prefix = await readUuidWindow(
    handle,
    0,
    Math.min(fileSize, HEADER_READ_LIMIT),
    ledger,
    signal,
  );
  if (!prefix.ok) return prefix;
  const magic = prefix.value.length >= 4 ? prefix.value.readUInt32BE(0) : 0;
  const universal =
    magic === 0xcafebabe ||
    magic === 0xcafebabf ||
    magic === 0xbebafeca ||
    magic === 0xbfbafeca;
  if (!universal) {
    const read = await readThinUuidEntry(
      handle,
      0,
      fileSize,
      ledger,
      signal,
      prefix.value,
    );
    return read.ok ? ok([read.value]) : read;
  }
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  // The architecture table follows the observed container byte order.
  const big = magic === 0xcafebabe || magic === 0xcafebabf;
  const read32 = big
    ? (position: number) => prefix.value.readUInt32BE(position)
    : (position: number) => prefix.value.readUInt32LE(position);
  if (prefix.value.length < 8)
    return err(
      invalidImage("the universal Mach-O container header is truncated"),
    );
  const count = read32(4);
  const entrySize = wide ? 32 : 20;
  if (count > 128 || 8 + count * entrySize > prefix.value.length)
    return err(
      invalidImage("the universal Mach-O container table is truncated"),
    );
  const entries: SliceUuidEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    throwIfCancelled(signal);
    const entry = 8 + index * entrySize;
    const cpuType = big
      ? prefix.value.readInt32BE(entry)
      : prefix.value.readInt32LE(entry);
    const sliceOffset = wide
      ? Number(
          big
            ? prefix.value.readBigUInt64BE(entry + 8)
            : prefix.value.readBigUInt64LE(entry + 8),
        )
      : read32(entry + 8);
    const sliceSize = wide
      ? Number(
          big
            ? prefix.value.readBigUInt64BE(entry + 16)
            : prefix.value.readBigUInt64LE(entry + 16),
        )
      : read32(entry + 12);
    if (sliceOffset > fileSize || sliceSize > fileSize - sliceOffset)
      return err(
        invalidImage("a universal Mach-O slice is out of file bounds"),
      );
    const read = await readThinUuidEntry(
      handle,
      sliceOffset,
      sliceSize,
      ledger,
      signal,
    );
    if (!read.ok) return read;
    // Even a UUID-less slice keeps its place in the target's family ordering.
    entries.push({ cpuType, uuid: read.value.uuid });
  }
  return ok(entries);
};

/**
 * Digest a DWARF member through the same handle its UUID was read from, so a
 * member atomically replaced on disk cannot pair another file's digest with
 * the validated UUID. The read loop honors cancellation between chunks.
 */
const digestOpenHandle = async (
  handle: FileHandle,
  initial: Stats,
  signal: AbortSignal | undefined,
): Promise<Result<string, string>> => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < initial.size) {
    throwIfCancelled(signal);
    const observed = await handle.read(chunk, 0, chunk.length, position);
    throwIfCancelled(signal);
    if (observed.bytesRead === 0) break;
    hash.update(chunk.subarray(0, observed.bytesRead));
    position += observed.bytesRead;
  }
  const opened = await handle.stat();
  throwIfCancelled(signal);
  if (!sameRegularFileState(initial, opened))
    return err("the dSYM DWARF member changed while being read");
  return ok(hash.digest("hex"));
};

/**
 * Admit a caller-selected dSYM bundle for a detected Mach-O target: the
 * bundle must contain a DWARF member whose LC_UUID matches the UUID of the
 * target image slice REA selected for the requested architecture. Only the
 * matched member is retained for staging; a non-Mach-O or unreadable member
 * candidate (for example `.DS_Store`) is skipped, not fatal.
 */
export const admitDebugCompanion = async (input: {
  readonly dsymPath: string;
  readonly targetHandle: FileHandle;
  readonly targetSize: number;
  readonly architecture: BinaryArchitecture;
  readonly targetSlice?: UniversalMachOSlice;
  readonly signal?: AbortSignal;
}): Promise<DebugCompanionAdmission> => {
  const { dsymPath, signal } = input;
  throwIfCancelled(signal);
  if (!isAbsolute(dsymPath))
    return err({
      reason:
        "dsym_path must be an absolute local filesystem path to a .dSYM bundle",
    });
  let bundle: Stats;
  try {
    bundle = await stat(dsymPath);
  } catch {
    return err({ reason: `dsym_path is not readable: ${dsymPath}` });
  }
  if (!bundle.isDirectory())
    return err({
      reason: `dsym_path is not a .dSYM bundle directory: ${dsymPath}`,
    });
  const dwarfDirectory = join(dsymPath, DSYM_DWARF_DIRECTORY);
  let directory: Dir;
  try {
    directory = await opendir(dwarfDirectory, {
      bufferSize: MEMBER_COUNT_LIMIT + 1,
    });
  } catch {
    return err({
      reason: `dsym_path has no Contents/Resources/DWARF member directory: ${dsymPath}`,
    });
  }
  const memberPaths: string[] = [];
  let examinedEntries = 0;
  for await (const entry of directory) {
    throwIfCancelled(signal);
    examinedEntries += 1;
    if (examinedEntries > MEMBER_COUNT_LIMIT)
      return err({
        reason: `dsym_path contains more than ${String(MEMBER_COUNT_LIMIT)} DWARF directory entries`,
      });
    const memberPath = join(dwarfDirectory, entry.name);
    const memberStat = await stat(memberPath).catch(() => undefined);
    if (memberStat?.isFile() !== true) continue;
    memberPaths.push(memberPath);
  }
  if (memberPaths.length === 0)
    return err({
      reason: `dsym_path contains no DWARF member file: ${dsymPath}`,
    });
  const ledger: TraversalLedger = { spent: 0 };
  const traversalOptions = {
    ledger,
    ...(signal === undefined ? {} : { signal }),
  };
  let targetEntries: Result<SliceUuidEntry[], MachOUuidReadFailure>;
  if (input.targetSlice === undefined) {
    targetEntries = await readMachoFileUuidEntries(
      input.targetHandle,
      input.targetSize,
      traversalOptions,
    );
  } else {
    // Target selection already owns the exact FAT entry. Read that region
    // directly instead of selecting a sibling again from a UUID inventory.
    const selected = await readThinUuidEntry(
      input.targetHandle,
      input.targetSlice.offset,
      input.targetSlice.size,
      ledger,
      signal,
    );
    targetEntries = selected.ok ? ok([selected.value]) : selected;
  }
  if (!targetEntries.ok) return err({ reason: targetEntries.error.reason });
  // Mirror the target parser's FAT selection: the first slice of each CPU
  // family is the one REA imports — including when that slice declares no
  // LC_UUID, in which case a same-family sibling cannot lend its UUID.
  const selectedCpuTypes = CPU_TYPES[input.architecture];
  const importedFamilies = new Set<number>();
  const selectedUuids: string[] = [];
  for (const { cpuType, uuid } of targetEntries.value) {
    const family = selectedCpuTypes.find((candidate) => candidate === cpuType);
    if (family === undefined || importedFamilies.has(family)) continue;
    importedFamilies.add(family);
    if (uuid !== null) selectedUuids.push(uuid);
  }
  if (selectedUuids.length === 0)
    return err({
      reason: `the target image declares no LC_UUID for the selected ${input.architecture} slice`,
    });
  for (const memberPath of memberPaths) {
    throwIfCancelled(signal);
    const memberHandle = await open(
      memberPath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    ).catch(() => undefined);
    if (memberHandle === undefined) continue;
    try {
      const initial = await memberHandle.stat();
      if (!initial.isFile()) continue;
      if (initial.size > MEMBER_SIZE_LIMIT_BYTES)
        return err({
          reason: `dsym DWARF member exceeds the supported size: ${memberPath}`,
        });
      const memberEntries = await readMachoFileUuidEntries(
        memberHandle,
        initial.size,
        traversalOptions,
      );
      if (!memberEntries.ok) {
        if (memberEntries.error.kind === "resource-limit")
          return err({ reason: memberEntries.error.reason });
        continue;
      }
      const matched = debugCompanionMatches({
        executableUuids: selectedUuids,
        companionUuids: memberEntries.value
          .map(({ uuid }) => uuid)
          .filter((uuid): uuid is string => uuid !== null),
      });
      if (!matched.ok) continue;
      const memberSha256 = await digestOpenHandle(
        memberHandle,
        initial,
        signal,
      );
      if (!memberSha256.ok) return err({ reason: memberSha256.error });
      return ok({
        sourcePath: dsymPath,
        memberPath,
        memberSha256: memberSha256.value,
        memberSizeBytes: initial.size,
        uuid: matched.value.uuid,
      });
    } finally {
      await memberHandle.close();
    }
  }
  return err({
    reason:
      "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
  });
};
