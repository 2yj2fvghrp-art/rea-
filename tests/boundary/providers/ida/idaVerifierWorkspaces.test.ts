import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  assertNoNewIdaWorkspaces,
  snapshotIdaWorkspaces,
} from "../../../../scripts/lib/ida-verifier-workspaces.mjs";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it("rejects a new headless workspace left behind by a CLI verifier run", async () => {
  const root = await createTestTempDirectory("rea-ida-verifier-workspace-");
  const existing = join(root, "rea-ida-existing");
  const leaked = join(root, "rea-ida-leaked");
  await mkdir(existing);
  const before = await snapshotIdaWorkspaces(root);
  await mkdir(leaked);
  try {
    const afterLeak = await snapshotIdaWorkspaces(root);
    expect(() => assertNoNewIdaWorkspaces(before, afterLeak)).toThrow(
      "left an IDA workspace",
    );
  } finally {
    await rm(leaked, { recursive: true, force: true });
  }
  assertNoNewIdaWorkspaces(before, await snapshotIdaWorkspaces(root));
});
