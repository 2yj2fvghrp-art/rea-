import { chmod, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
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
    if (
      /(?:^|\s)\/\S*\/proot(?:-\S*)?(?:\s|\/)/u.test(
        readFileSync("/proc/self/mountinfo", "utf8"),
      )
    )
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

it("rejects a file whose mtime moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-regularfile-"));
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const before = await stat(path);
  // Moving the timestamp explicitly keeps size, dev, ino and mode stable, so
  // only the timestamp comparison can detect the change.
  const future = new Date(before.mtimeMs + 10_000);
  await utimes(path, future, future);
  const after = await stat(path);

  expect(after.size).toBe(before.size);
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

it("compares BigIntStats without throwing on the file-type mask", async () => {
  // BigIntStats.mode is a BigInt. The file-type comparison must not mix a
  // BigInt with the Number mask, which would throw a TypeError.
  const root = await mkdtemp(join(tmpdir(), "rea-regularfile-"));
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const first = await stat(path, { bigint: true });
  const second = await stat(path, { bigint: true });

  expect(sameRegularFileState(first, second)).toBe(true);
});
