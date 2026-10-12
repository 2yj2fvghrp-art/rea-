import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { ZipArtifactReader } from "./ZipArtifactReader.js";
import {
  ARTIFACT_DECOMPRESSION_RATIO,
  artifactDecompressionBudgetBytes,
  MINIMUM_ARTIFACT_DECOMPRESSION_BYTES,
} from "../domain/artifactDecompressionBudget.js";

/** Small real ZIP carriers with forged sizes; metadata-only controls, never decompressed. */
const writeZipWithDeclaredSize = async (
  directory: string,
  declaredBytes: readonly number[],
): Promise<string> => {
  const path = join(directory, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [index] of declaredBytes.entries())
    await writer.add(
      `member-${index}.bin`,
      new TextReader("real member bytes"),
    );
  await writeFile(path, await writer.close());
  const bytes = await readFile(path);
  let offset = 0;
  for (const declared of declaredBytes) {
    const centralDirectory = bytes.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      offset,
    );
    if (centralDirectory < 0)
      throw new Error("Expected a ZIP central directory");
    // Metadata-only controls: these declarations do not describe valid member streams.
    bytes.writeUInt32LE(declared, centralDirectory + 24);
    offset = centralDirectory + 46;
  }
  await writeFile(path, bytes);
  return path;
};

const enumerate = async (reader: ZipArtifactReader): Promise<number> => {
  let files = 0;
  for await (const entry of reader.entries())
    if (entry.kind === "file") files += 1;
  return files;
};

describe("ZipArtifactReader decompression budget", () => {
  it("refuses an archive whose entries declare more than its size can justify", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-bomb-");
    // A ~160-byte archive cannot declare 2 GiB of members without being a bomb.
    const path = await writeZipWithDeclaredSize(directory, [2_147_483_647]);
    const reader = new ZipArtifactReader(path, "zip");
    try {
      await expect(enumerate(reader)).rejects.toMatchObject({
        name: "ArtifactReaderFailure",
        reason: "limit",
      });
    } finally {
      await reader.close();
    }
  });

  it("charges all declarations in one traversal before yielding an over-budget member", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-total-");
    const half = MINIMUM_ARTIFACT_DECOMPRESSION_BYTES / 2;
    const path = await writeZipWithDeclaredSize(directory, [half, half + 1]);
    const reader = new ZipArtifactReader(path, "zip");
    const iterator = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.declaredSize).toBe(half);
      await expect(iterator.next()).rejects.toMatchObject({ reason: "limit" });
    } finally {
      await iterator.return?.();
      await reader.close();
    }
  });

  it("keeps repeated and interleaved metadata traversals independently charged", async () => {
    const directory = await createTestTempDirectory(
      "rea-zip-budget-iterators-",
    );
    const path = await writeZipWithDeclaredSize(directory, [
      MINIMUM_ARTIFACT_DECOMPRESSION_BYTES / 2,
      MINIMUM_ARTIFACT_DECOMPRESSION_BYTES / 2,
    ]);
    const reader = new ZipArtifactReader(path, "zip");
    const first = reader.entries()[Symbol.asyncIterator]();
    const second = reader.entries()[Symbol.asyncIterator]();
    try {
      expect((await first.next()).done).toBe(false);
      expect((await second.next()).done).toBe(false);
      expect((await first.next()).done).toBe(false);
      expect((await second.next()).done).toBe(false);
      expect((await first.next()).done).toBe(true);
      expect((await second.next()).done).toBe(true);
      expect(await enumerate(reader)).toBe(2);
    } finally {
      await Promise.all([first.return?.(), second.return?.()]);
      await reader.close();
    }
  });

  it("streams valid member bytes within the budget instead of only trusting declarations", async () => {
    const directory = await createTestTempDirectory("rea-zip-budget-valid-");
    const path = join(directory, "valid.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("member.bin", new TextReader("valid member bytes"));
    await writeFile(path, await writer.close());
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries[0];
      if (entry === undefined) throw new Error("Expected a ZIP member");
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.open(entry))
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("valid member bytes");
    } finally {
      await reader.close();
    }
  });
});

describe("artifactDecompressionBudgetBytes", () => {
  it("grants at least the floor and grows with the compressed size", () => {
    expect(artifactDecompressionBudgetBytes(0)).toBe(
      MINIMUM_ARTIFACT_DECOMPRESSION_BYTES,
    );
    expect(artifactDecompressionBudgetBytes(1024)).toBe(
      MINIMUM_ARTIFACT_DECOMPRESSION_BYTES,
    );
    const large = MINIMUM_ARTIFACT_DECOMPRESSION_BYTES * 4;
    expect(artifactDecompressionBudgetBytes(large)).toBe(
      large * ARTIFACT_DECOMPRESSION_RATIO,
    );
  });
});
