import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

/** Snapshot only IDA workspaces in the root selected by the registration. */
export const snapshotIdaWorkspaces = async (root) => {
  try {
    return new Set(
      (await readdir(root)).filter((name) => name.startsWith("rea-ida-")),
    );
  } catch (cause) {
    if (cause.code === "ENOENT") return new Set();
    throw cause;
  }
};

/** Fail when one CLI workflow leaves a new owned workspace behind. */
export const assertNoNewIdaWorkspaces = (before, after) =>
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)).sort(),
    [],
    "The separate CLI overview run left an IDA workspace in the configured root.",
  );
