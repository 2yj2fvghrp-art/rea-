import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves known originals beside unnamed source-map entries through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-unnamed-map-source-");
    const original = "export const answer: number = 42;";
    const map = {
      version: 3,
      sources: [null, "original.ts"],
      sourcesContent: [null, original],
      names: [],
      mappings: "ACAA",
    };
    const mapText = JSON.stringify(map);
    const mapPath = join(root, "bundle.js.map");
    await writeFile(mapPath, mapText);
    await writeFile(
      join(root, "bundle.js"),
      "export const answer=42;\n//# sourceMappingURL=bundle.js.map\n",
    );
    expect(
      originalPositionFor(new TraceMap(mapText, "file:///bundle.js.map"), {
        line: 1,
        column: 0,
      }).source,
    ).toBe("file:///original.ts");
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const originals = graph.nodes.filter(
      (node) => node.identity.strategy === "source-map-original",
    );
    expect(originals).toHaveLength(1);
    expect(originals[0]?.identity).toMatchObject({
      original_source: "original.ts",
      source_map_sha256: createHash("sha256").update(mapText).digest("hex"),
      source_sha256: createHash("sha256").update(original).digest("hex"),
    });
    expect(graph.coverage.status).toBe("partial");
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            evidence: expect.objectContaining({
              limitations: expect.arrayContaining([
                expect.stringContaining("unnamed source"),
              ]),
            }),
          }),
        ]),
      }),
    );
    expect(await readFile(mapPath, "utf8")).toBe(mapText);

    const malformedRoot = await createTestTempDirectory(
      "rea-invalid-map-source-",
    );
    await writeFile(
      join(malformedRoot, "invalid.js.map"),
      JSON.stringify({
        version: 3,
        sources: [42, "discarded.ts"],
        sourcesContent: [null, original],
        names: [],
        mappings: "ACAA",
      }),
    );
    const malformed = await analyzeJavaScriptDirectory(
      surface,
      cli,
      malformedRoot,
    );
    expect(malformed.graph.coverage.status).toBe("partial");
    expect(
      malformed.graph.nodes.some(
        (node) => node.identity.strategy === "source-map-original",
      ),
    ).toBe(false);
    expect(malformed.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "unknown",
        observations: expect.arrayContaining([
          expect.objectContaining({
            evidence: expect.objectContaining({
              limitations: expect.arrayContaining([
                "Source map contains a non-string source name.",
              ]),
            }),
          }),
        ]),
      }),
    );
  },
);
