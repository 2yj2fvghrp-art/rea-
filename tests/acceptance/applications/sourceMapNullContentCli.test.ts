import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves null source-map content as unavailable content through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-null-map-content-");
    const map = {
      version: 3,
      sources: ["original.ts"],
      sourcesContent: null,
      names: [],
      mappings: "AAAA",
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
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({
          strategy: "source-map-original",
          original_source: "original.ts",
          source_map_sha256: createHash("sha256").update(mapText).digest("hex"),
          source_sha256: null,
        }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ content_available: false }),
          }),
        ]),
      }),
    );
    expect(graph.coverage.status).toBe("complete");
    expect(await readFile(mapPath, "utf8")).toBe(mapText);
  },
);
