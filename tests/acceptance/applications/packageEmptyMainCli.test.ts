import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "uses the legacy index for an empty package main through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-empty-main-");
    const packagePath = join(root, "node_modules", "fixture");
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, "package.json"), '{"main":""}');
    await writeFile(join(packagePath, "index.js"), "module.exports = 42;");
    const entrypoints = {
      "entry.mjs": 'import value from "fixture"; console.log(value);',
      "entry.cjs": 'console.log(require("fixture"));',
    };
    for (const [name, text] of Object.entries(entrypoints)) {
      await writeFile(join(root, name), text);
      if (surface === "CLI") {
        const native = await promisify(execFile)(
          process.execPath,
          [join(root, name)],
          { timeout: 5_000 },
        );
        expect(native.stdout).toBe("42\n");
      }
    }
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const imports = graph.edges.filter(
      (edge) =>
        edge.relation === "imports" &&
        edge.properties.specifier === "fixture" &&
        edge.properties.resolution_status !== undefined,
    );
    expect(imports).toHaveLength(2);
    for (const edge of imports)
      expect(edge.properties).toMatchObject({
        resolved_path: "node_modules/fixture/index.js",
        resolution_status: "resolved",
      });
  },
);
