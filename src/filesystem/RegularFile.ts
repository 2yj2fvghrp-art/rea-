import { constants, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";

import { OwnedFileHandle } from "./OwnedFileHandle.js";

/** Identifies a selected path that cannot be read as one regular file. */
export class NonRegularFileReadError extends Error {
  readonly code: "EISDIR" | "ENOTFILE";

  constructor(
    readonly path: string,
    directory: boolean,
  ) {
    super(`Selected input must be a regular file: ${path}`);
    this.name = "NonRegularFileReadError";
    this.code = directory ? "EISDIR" : "ENOTFILE";
  }
}

/** Admission failed and the opened descriptor could not be confirmed closed. */
export class RegularFileAdmissionFailure extends Error {
  override readonly cause: unknown;

  constructor(
    readonly path: string,
    admissionCause: unknown,
    readonly cleanupCause: unknown,
    readonly owner: OwnedFileHandle,
  ) {
    super(
      `Selected input failed admission and its descriptor close failed: ${path}`,
    );
    this.name = "RegularFileAdmissionFailure";
    this.cause = admissionCause;
  }
}

/** A regular input no longer matches the extent or identity admitted for reading. */
export class RegularFileChangedError extends Error {
  readonly code = "ESTALE";
  constructor(readonly path: string) {
    super(`Selected input changed while being read: ${path}`);
    this.name = "RegularFileChangedError";
  }
}

/** One admitted file descriptor and the metadata that identified its contents. */
export interface StableRegularFileDescriptor {
  readonly handle: FileHandle;
  readonly initial: Stats;
}

/** Open and verify the selected file descriptor without blocking on pipes. */
export const openRegularFile = async (
  path: string,
  options: {
    readonly symlinks: "follow" | "reject";
    readonly signal?: AbortSignal | undefined;
  },
): Promise<FileHandle> => {
  options.signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOCTTY ?? 0) |
      (options.symlinks === "reject" ? (constants.O_NOFOLLOW ?? 0) : 0),
  ).catch(async (cause: unknown) => {
    const nonRegular = await nonRegularOpenFailure(
      path,
      options.symlinks,
      cause,
    );
    if (nonRegular === undefined) throw cause;
    // Cancellation during the metadata probe outranks the reclassification.
    options.signal?.throwIfAborted();
    throw nonRegular;
  });
  const owner = new OwnedFileHandle(handle);
  try {
    options.signal?.throwIfAborted();
    const metadata = await handle.stat();
    options.signal?.throwIfAborted();
    if (!metadata.isFile())
      throw new NonRegularFileReadError(path, metadata.isDirectory());
    // O_NOFOLLOW is unavailable on Windows. Recheck the name only on hosts
    // where open could have followed a symlink, while the descriptor is owned.
    if (options.symlinks === "reject" && (constants.O_NOFOLLOW ?? 0) === 0) {
      const named = await lstat(path);
      options.signal?.throwIfAborted();
      if (named.isSymbolicLink())
        throw new NonRegularFileReadError(path, false);
      if (!sameRegularFileState(metadata, named))
        throw new RegularFileChangedError(path);
    }
    return handle;
  } catch (cause: unknown) {
    try {
      await owner.close();
    } catch (cleanupCause: unknown) {
      throw new RegularFileAdmissionFailure(path, cause, cleanupCause, owner);
    }
    throw cause;
  }
};

/**
 * Some non-regular files cannot be opened at all: a Unix socket fails with
 * ENXIO on Linux and EOPNOTSUPP on macOS. Confirm such a failure against
 * the path's own metadata before reporting a non-regular selection.
 */
const nonRegularOpenFailure = async (
  path: string,
  symlinks: "follow" | "reject",
  cause: unknown,
): Promise<NonRegularFileReadError | undefined> => {
  // Only errors meaning "this file type cannot be opened" are reclassified;
  // permission, symlink-rejection and resource failures keep their codes.
  if (!isUnopenableFileTypeError(cause)) return undefined;
  const metadata = await (symlinks === "reject" ? lstat : stat)(path).catch(
    () => undefined,
  );
  if (metadata === undefined || metadata.isFile()) return undefined;
  return new NonRegularFileReadError(path, metadata.isDirectory());
};

// Match by errno: libuv has no name for macOS EOPNOTSUPP (102) and reports
// "Unknown system error -102" as its code.
const errnos: Partial<Record<string, number>> = osConstants.errno;
const UNOPENABLE_FILE_TYPE_ERRNOS: ReadonlySet<number> = new Set(
  [errnos.ENXIO, errnos.EOPNOTSUPP, errnos.ENOTSUP].flatMap((errno) =>
    errno === undefined ? [] : [-errno],
  ),
);

const isUnopenableFileTypeError = (cause: unknown): boolean =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  UNOPENABLE_FILE_TYPE_ERRNOS.has(cause.errno);

// S_IFMT isolates the file type from a POSIX mode value (regular file,
// directory, socket, ...). The remaining bits are the permission bits.
const FILE_TYPE_MASK = 0o170000;

/**
 * Detect PRoot environments (e.g. Termux on Android) where stat() and fstat()
 * report different mode permission bits and ctime for the very same file,
 * because PRoot's syscall interception resolves inode metadata per call. On
 * those hosts the permission bits of mode and ctime are not reliable stability
 * indicators, so sameRegularFileState excludes them from its comparison.
 */
const isPRootEnvironment = (): boolean => {
  // PRoot sets no dedicated environment variable. /proc/version reports
  // "PRoot-Distro" inside every PRoot-Distro container and
  // /proc/self/mountinfo lists proot-managed mounts.
  try {
    if (readFileSync("/proc/version", "utf8").includes("PRoot")) return true;
  } catch {
    // /proc/version unreadable — fall through to the mountinfo probe.
  }
  try {
    if (readFileSync("/proc/self/mountinfo", "utf8").includes("/proot"))
      return true;
  } catch {
    // /proc/self/mountinfo unreadable — treat the host as non-PRoot.
  }
  return false;
};

/** Compare one regular file's identity and mutable metadata across a read. */
export const sameRegularFileState = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
): boolean => {
  if (!observed.isFile()) return false;
  if (expected.dev !== observed.dev) return false;
  if (expected.ino !== observed.ino) return false;
  if (expected.size !== observed.size) return false;
  if (isPRootEnvironment()) {
    // Permission bits differ between stat() and fstat() under PRoot; only a
    // genuine change of the file type itself still counts as a change.
    if ((expected.mode & FILE_TYPE_MASK) !== (observed.mode & FILE_TYPE_MASK))
      return false;
    // ctime is updated asynchronously by PRoot, so it is never compared here.
    if ("mtimeNs" in expected && "mtimeNs" in observed) {
      if (expected.mtimeNs !== observed.mtimeNs) return false;
    } else {
      if (expected.mtimeMs !== observed.mtimeMs) return false;
    }
  } else {
    if (expected.mode !== observed.mode) return false;
    if ("mtimeNs" in expected && "mtimeNs" in observed) {
      if (expected.mtimeNs !== observed.mtimeNs) return false;
      if (expected.ctimeNs !== observed.ctimeNs) return false;
    } else {
      if (expected.mtimeMs !== observed.mtimeMs) return false;
      if (expected.ctimeMs !== observed.ctimeMs) return false;
    }
  }
  return true;
};
