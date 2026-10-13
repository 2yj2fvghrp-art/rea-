import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { stageGhidraDebugCompanion } from "../../../src/ghidra/GhidraDebugCompanion.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const stagingFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-staging-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("caller-selected DWARF member bytes");
  const runtime = join(root, "private-runtime");
  await mkdir(runtime);
  const memberPath = join(root, "original-member");
  await writeFile(memberPath, bytes, { mode: 0o640 });
  return {
    bytes,
    runtime,
    snapshot: join(runtime, "snapshot-name"),
    stagedBundle: join(runtime, "snapshot-name.dSYM"),
    stagedMember: join(
      runtime,
      "snapshot-name.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "snapshot-name",
    ),
    companion: {
      sourcePath: join(root, "caller.dSYM"),
      memberPath,
      memberSha256: createHash("sha256").update(bytes).digest("hex"),
      memberSizeBytes: bytes.length,
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  };
};

it("stages verified bytes under the snapshot name with private permissions and source provenance", async () => {
  const fixture = await stagingFixture();
  const sourceBefore = await stat(fixture.companion.memberPath);
  expect(
    await stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
    ),
  ).toEqual({
    dsym: {
      source_path: fixture.companion.sourcePath,
      member_sha256: fixture.companion.memberSha256,
      uuid: fixture.companion.uuid,
      staged_member: fixture.stagedMember,
    },
  });
  expect(await readFile(fixture.stagedMember)).toEqual(fixture.bytes);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
  if (process.platform !== "win32") {
    expect((await stat(fixture.stagedMember)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.companion.memberPath)).mode).toBe(
      sourceBefore.mode,
    );
  }
});

it("rejects a changed digest and removes the partial staged bundle while preserving source bytes", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSha256: "0".repeat(64) },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("dSYM member digest mismatch");
  await expect(access(fixture.stagedBundle)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});

it("bounds a grown member by its admitted size and cleans the staged copy", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSizeBytes: fixture.bytes.length - 1 },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("grew beyond its admitted size");
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});

it("cleans partial staging after cancellation without changing the selected member", async () => {
  const fixture = await stagingFixture();
  const controller = new AbortController();
  controller.abort(new Error("cancel dSYM staging"));
  await expect(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});
