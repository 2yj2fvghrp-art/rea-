import { createHash } from "node:crypto";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readRegularFile,
  RegularFileCleanupFailure,
} from "./RegularFileRead.js";

interface RecoveryBackupSelection {
  readonly backupPath: string;
  readonly present: boolean;
}

interface RecoveryBackupSelectionFailure {
  readonly kind: "unreadable" | "occupied";
  readonly path: string;
  readonly detail: string;
}

/** Preserve the first backup while selecting a verified snapshot of current bytes. */
export const selectCurrentRecoveryBackup = async (
  firstBackupPath: string,
  original: string,
  resources?: ArtifactResourceScope,
): Promise<Result<RecoveryBackupSelection, RecoveryBackupSelectionFailure>> => {
  const expected = Buffer.from(original, "utf8");
  const readBackup = (path: string): Promise<Buffer> =>
    readRegularFile(path, {
      symlinks: "reject",
      ...(resources === undefined ? {} : { resources }),
    });
  const unreadable = (path: string, cause: unknown) =>
    err({
      kind: "unreadable" as const,
      path,
      detail: `The recovery backup could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  const isMissing = (cause: unknown): boolean =>
    cause instanceof Error && "code" in cause && cause.code === "ENOENT";
  let firstBackup: Buffer | undefined;
  try {
    firstBackup = await readBackup(firstBackupPath);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause)) return unreadable(firstBackupPath, cause);
  }
  if (firstBackup === undefined)
    return ok({ backupPath: firstBackupPath, present: false });
  if (firstBackup.equals(expected))
    return ok({ backupPath: firstBackupPath, present: true });

  const digest = createHash("sha256").update(original, "utf8").digest("hex");
  const recoveryPath = `${firstBackupPath}.${digest}.recovery`;
  let recovery: Buffer | undefined;
  try {
    recovery = await readBackup(recoveryPath);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause)) return unreadable(recoveryPath, cause);
  }
  if (recovery !== undefined && !recovery.equals(expected))
    return err({
      kind: "occupied",
      path: recoveryPath,
      detail: `The recovery path already contains different data: ${recoveryPath}`,
    });
  return ok({ backupPath: recoveryPath, present: recovery !== undefined });
};
