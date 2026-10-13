import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_PORTABLE_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PORTABLE_MANIFEST_FILES = 50_000;

/** Read and bound an untrusted portable inventory before using its entries. */
export async function readPortableManifest(path) {
  const file = await open(path, "r");
  let chunks;
  let size = 0;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile())
      throw new Error("Portable manifest must be a regular file.");
    if (metadata.size > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error("Portable manifest exceeds the 8 MiB limit.");
    chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    while (size <= MAX_PORTABLE_MANIFEST_BYTES) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, MAX_PORTABLE_MANIFEST_BYTES + 1 - size),
        size,
      );
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      size += bytesRead;
    }
    if (size > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error("Portable manifest exceeds the 8 MiB limit.");
  } finally {
    await file.close();
  }

  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    ),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Portable manifest must contain a files array.");
  if (manifest.files.length > MAX_PORTABLE_MANIFEST_FILES)
    throw new Error("Portable manifest exceeds the 50,000-file limit.");
  return manifest;
}

/** Hash one opened file with bounded buffers; reject size mismatches before reads. */
export async function hashPortableFile(path, expectedSize) {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile())
      throw new Error(
        `Portable inventory contains a non-regular file: ${path}`,
      );
    if (expectedSize !== undefined && metadata.size !== expectedSize)
      throw new Error(
        `Portable file size mismatch: ${path}; expected ${expectedSize}, observed ${metadata.size}`,
      );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      size += chunk.length;
      if (size > metadata.size)
        throw new Error(`Portable file size changed while hashing: ${path}`);
      hash.update(chunk);
    }
    if (size !== metadata.size)
      throw new Error(`Portable file size changed while hashing: ${path}`);
    return { size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

/** Require exact files and their parent directories before running the artifact. */
export async function verifyPortableInventory(directory, files) {
  const actual = [];
  const parents = new Set();
  for (const { path } of files) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++)
      parents.add(parts.slice(0, length).join("/"));
  }
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        // Even an empty package directory can shadow a hoisted Node dependency.
        if (!parents.has(path))
          throw new Error(
            `Portable inventory contains an unlisted directory: ${path}`,
          );
        await visit(join(current, entry.name), `${path}/`);
      } else if (!entry.isFile())
        throw new Error(
          `Portable inventory contains a non-regular entry: ${path}`,
        );
      else if (path !== "portable.json") actual.push(path);
    }
  }
  await visit(directory);
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    actual.sort(),
    "Portable inventory must match the exact regular-file set",
  );
}
