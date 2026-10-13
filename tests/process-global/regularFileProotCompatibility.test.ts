import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { sameRegularFileState } from "../../src/filesystem/RegularFile.js";

/** Mirrors the host probe inside sameRegularFileState. */
const isPRootHost = (): boolean => {
  try {
    if (readFileSync("/proc/version", "utf8").includes("PRoot")) return true;
  } catch {
    /* fall through */
  }
  try {
    if (readFileSync("/proc/self/mountinfo", "utf8").includes("/proot"))
      return true;
  } catch {
    /* fall through */
  }
  return false;
};

it("accepts identical regular-file metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-regularfile-"));
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const first = await stat(path);
  const second = await stat(path);

  expect(sameRegularFileState(first, second)).toBe(true);
});

it("rejects a changed regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-regularfile-"));
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const before = await stat(path);
  await writeFile(path, "changed content");
  const after = await stat(path);

  expect(sameRegularFileState(before, after)).toBe(false);
});

it.runIf(isPRootHost())(
  "tolerates PRoot permission-bit differences between stat calls",
  async () => {
    // Under PRoot, chmod is reflected differently by stat() and fstat() on the
    // same file. sameRegularFileState must compare only the file type.
    const root = await mkdtemp(join(tmpdir(), "rea-regularfile-"));
    const path = join(root, "file.bin");
    await writeFile(path, "content");

    const before = await stat(path);
    await chmod(path, 0o400);
    const after = await stat(path);

    expect(sameRegularFileState(before, after)).toBe(true);
  },
);
