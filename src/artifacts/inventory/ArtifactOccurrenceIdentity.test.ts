import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { crc32 } from "node:zlib";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../tests/fixtures/artifactInventory.js";
import { compareArtifacts } from "../../domain/artifactComparison.js";
import { occurrenceIdForLocation } from "../../domain/artifactIdentity.js";
import { projectAppleApplication } from "../../domain/apple/appleApplication.js";
import { createEvidence } from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { thinMach } from "../../domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const names = ["main.js", "payload.bin", "addon.node"];

const textEncoder = new TextEncoder();

/** Build a minimal stored (uncompressed) ZIP, allowing duplicate entry names. */
const storedZip = (
  entries: ReadonlyArray<readonly [string, string]>,
): Uint8Array => {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = textEncoder.encode(name);
    const data = textEncoder.encode(content);
    const checksum = crc32(data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.length,
    0,
  );
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const part of [
    ...localParts,
    ...centralParts,
    new Uint8Array(end.buffer),
  ]) {
    output.set(part, position);
    position += part.length;
  }
  return output;
};

const observeArchive = async (order: readonly string[]) => {
  const directory = await createTestTempDirectory("rea-occurrence-identity-");
  const path = join(directory, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const name of order)
    await writer.add(name, new TextReader("same content\n"), {
      lastModDate: new Date("2020-01-01T00:00:00Z"),
      executable: name === "addon.node",
    });
  await writeFile(path, await writer.close());
  const inventory = await inventoryArtifact(path);
  const evidence = createEvidence(
    { path, sha256: inventory.manifest.root_sha256, format: "zip" },
    { id: "rea-artifact-graph", name: "artifact inventory", version: "1" },
    {
      operation: "inventory_artifact",
      parameters: {},
      result: jsonValueSchema.parse(inventory),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
  return { inventory, evidence };
};

describe("content identity and occurrence facts", () => {
  it("retains all roles and permissions for identical bytes in either archive order", async () => {
    const left = await observeArchive(names);
    const right = await observeArchive([...names].reverse());
    const childNodes = (inventory: typeof left.inventory) =>
      inventory.nodes.filter(
        (node) => node.artifact_id !== inventory.manifest.root_artifact_id,
      );
    expect(childNodes(left.inventory)).toEqual(childNodes(right.inventory));
    expect(childNodes(left.inventory)).toHaveLength(1);
    expect(childNodes(left.inventory)[0]).toMatchObject({ format: "file" });
    expect(childNodes(left.inventory)[0]).not.toHaveProperty("kind");
    expect(childNodes(left.inventory)[0]).not.toHaveProperty("executable");
    const occurrences = left.inventory.occurrences.filter(
      (item) => item.logical_path !== ".",
    );
    expect(new Set(occurrences.map((item) => item.artifact_id)).size).toBe(1);
    expect(
      occurrences.map(
        ({ logical_path, artifact_kind, artifact_format, executable }) => ({
          logical_path,
          artifact_kind,
          artifact_format,
          executable,
        }),
      ),
    ).toEqual([
      {
        logical_path: "addon.node",
        artifact_kind: "native-addon",
        artifact_format: "file",
        executable: true,
      },
      {
        logical_path: "main.js",
        artifact_kind: "javascript",
        artifact_format: "javascript-bundle",
        executable: false,
      },
      {
        logical_path: "payload.bin",
        artifact_kind: "resource",
        artifact_format: "file",
        executable: false,
      },
    ]);
    expect(
      compareArtifacts(left.evidence, right.evidence).changes.map(
        (item) => item.logical_path,
      ),
    ).toEqual(["."]);
  });

  it.each([
    ["a later", ["a.js", "z.txt"]],
    ["an earlier", ["0.txt", "a.js"]],
    ["no", ["a.js"]],
  ] as const)(
    "keeps the Apple JavaScript component with %s byte-identical text resource",
    async (_label, resources) => {
      const directory = await createTestTempDirectory("rea-apple-identity-");
      const path = join(directory, "fixture.zip");
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add(
        "Demo.app/Contents/Info.plist",
        new TextReader(
          '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Demo</string></dict></plist>',
        ),
      );
      for (const name of resources)
        await writer.add(
          `Demo.app/Contents/Resources/${name}`,
          new TextReader('console.log("hello");\n'),
        );
      await writeFile(path, await writer.close());
      const inventory = await inventoryArtifact(path);
      const projection = projectAppleApplication({
        inventory_evidence: [
          createEvidence(
            { path, sha256: inventory.manifest.root_sha256, format: "zip" },
            {
              id: "rea-artifact-graph",
              name: "artifact inventory",
              version: "1",
            },
            {
              operation: "inventory_artifact",
              parameters: {},
              result: jsonValueSchema.parse(inventory),
              confidence: "observed",
              authority: "shipped-artifact",
            },
          ),
        ],
      });
      expect(
        projection.components.javascript.map((component) => component.path),
      ).toEqual(["Demo.app/Contents/Resources/a.js"]);
      expect(projection.runtime_families).toEqual(["javascript"]);
    },
  );

  it("keeps framework and ordinary directory roles separate for identical trees", async () => {
    const root = await createTestTempDirectory("rea-directory-roles-");
    for (const name of ["Widget.framework", "resources"])
      await mkdir(join(root, name));
    const inventory = await inventoryArtifact(root);
    const entries = inventory.occurrences.filter(
      (item) => item.logical_path !== ".",
    );
    expect(entries[0]?.artifact_id).toBe(entries[1]?.artifact_id);
    expect(entries.map((item) => item.artifact_kind).sort()).toEqual([
      "container",
      "framework",
    ]);
    expect(
      inventory.nodes.filter((node) => node.content_state === "virtual"),
    ).toHaveLength(1);
  });

  it("reports only an occurrence permission change for identical content", async () => {
    const root = await createTestTempDirectory("rea-permission-identity-");
    const path = join(root, "payload.bin");
    await writeFile(path, "same content\n", { mode: 0o600 });
    const before = await inventoryArtifact(root);
    await chmod(path, 0o700);
    const after = await inventoryArtifact(root);
    expect(before.nodes).toEqual(after.nodes);
    expect(before.manifest.root_artifact_id).toBe(
      after.manifest.root_artifact_id,
    );
    const oldFile = before.occurrences.find(
      (item) => item.logical_path === "payload.bin",
    );
    const newFile = after.occurrences.find(
      (item) => item.logical_path === "payload.bin",
    );
    expect(oldFile?.artifact_id).toBe(newFile?.artifact_id);
    expect(oldFile?.executable).toBe(false);
    expect(newFile?.executable).toBe(true);
  });
});

describe("directly selected executable formats", () => {
  // A 64-bit little-endian arm64 MH_EXECUTE header.
  const executable = () => {
    const bytes = thinMach(0xcffaedfe, 0x0100000c);
    bytes.writeUInt32LE(2, 12);
    return bytes;
  };

  it.each([
    ["755", 0o755],
    ["644", 0o644],
  ] as const)(
    "keeps a Mach-O executable kind separate from mode %s, directly and in a bundle",
    async (_label, mode) => {
      const root = await createTestTempDirectory("rea-direct-macho-");
      const directory = join(root, "Demo.app", "Contents", "MacOS");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "demo");
      await writeFile(path, executable());
      await chmod(path, mode);
      const facts = (
        inventory: Awaited<ReturnType<typeof inventoryArtifact>>,
        logicalPath: string,
      ) => {
        const occurrence = inventory.occurrences.find(
          (item) => item.logical_path === logicalPath,
        );
        const node = inventory.nodes.find(
          (item) => item.artifact_id === occurrence?.artifact_id,
        );
        return {
          sha256: node?.sha256,
          artifact_kind: occurrence?.artifact_kind,
          artifact_format: occurrence?.artifact_format,
          executable: occurrence?.executable,
        };
      };
      const direct = facts(await inventoryArtifact(path), ".");
      const embedded = facts(
        await inventoryArtifact(join(root, "Demo.app")),
        "Contents/MacOS/demo",
      );
      expect(direct).toEqual({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        artifact_kind: "executable",
        artifact_format: "mach-o",
        executable: mode === 0o755,
      });
      expect(embedded).toEqual(direct);
    },
  );
});

describe("duplicate archive entry paths", () => {
  it("reports duplicate ZIP paths without hiding the remaining members", async () => {
    const directory = await createTestTempDirectory("rea-duplicate-zip-path-");
    const path = join(directory, "duplicate.zip");
    await writeFile(
      path,
      storedZip([
        ["Chemin.txt", "first occurrence\n"],
        ["Chemin.txt", "second occurrence\n"],
        ["other.txt", "visible member\n"],
      ]),
    );

    const inventory = await inventoryArtifact(path);
    const duplicates = inventory.occurrences.filter(
      ({ logical_path }) => logical_path === "Chemin.txt",
    );

    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]?.occurrence_id).toBe(
      occurrenceIdForLocation({
        rootArtifactId: inventory.manifest.root_artifact_id,
        logicalPath: "Chemin.txt",
        entryKind: "file",
      }),
    );
    expect(duplicates[1]?.occurrence_id).toBe(
      occurrenceIdForLocation({
        rootArtifactId: inventory.manifest.root_artifact_id,
        logicalPath: "Chemin.txt",
        entryKind: "file",
        duplicateOrdinal: 1,
      }),
    );
    expect(duplicates[0]?.limitations).not.toContain(
      "Duplicate archive entry path; earlier occurrence of this path exists.",
    );
    expect(duplicates[1]?.limitations).toContain(
      "Duplicate archive entry path; earlier occurrence of this path exists.",
    );
    expect(
      inventory.occurrences.some(
        ({ logical_path }) => logical_path === "other.txt",
      ),
    ).toBe(true);

    const evidence = createEvidence(
      { path, sha256: inventory.manifest.root_sha256, format: "zip" },
      { id: "rea-artifact-graph", name: "artifact inventory", version: "1" },
      {
        operation: "inventory_artifact",
        parameters: {},
        result: jsonValueSchema.parse(inventory),
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    expect(evidence.operation).toBe("inventory_artifact");
  });
});
