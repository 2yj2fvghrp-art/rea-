import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

const requests = [
  {
    specifier: "./feature",
    target: null,
    status: "not-found",
    error: "MODULE_NOT_FOUND",
  },
  {
    specifier: "./feature.cjs",
    target: "feature.cjs",
    status: "resolved",
    error: null,
  },
  {
    specifier: "./moduleOnly",
    target: null,
    status: "not-found",
    error: "MODULE_NOT_FOUND",
  },
  {
    specifier: "./directory",
    target: null,
    status: "not-found",
    error: "MODULE_NOT_FOUND",
  },
  {
    specifier: "./legacy",
    target: "legacy.js",
    status: "resolved",
    error: null,
  },
  {
    specifier: "./data",
    target: "data.json",
    status: "resolved",
    error: null,
  },
  {
    specifier: "./validDirectory",
    target: "validDirectory/index.js",
    status: "resolved",
    error: null,
  },
];
cliTest.for(["CLI", "stdio MCP"] as const)(
  "uses only Node CommonJS extension candidates through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-require-extensions-");
    const files = {
      "feature.cjs": "module.exports=42;",
      "moduleOnly.mjs": "export default 42;",
      "directory/index.cjs": "module.exports=42;",
      "legacy.js": "module.exports=42;",
      "data.json": "42",
      "validDirectory/index.js": "module.exports=42;",
      "typed.cts":
        'const value=require("./typed-dep.cjs");module.exports=value;',
      "typed-dep.cts": "module.exports=42;",
    };
    for (const [path, text] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
    }
    await writeFile(
      join(root, "entry.cjs"),
      requests
        .map(
          ({ specifier }, index) =>
            "const value" +
            index +
            " = require(" +
            JSON.stringify(specifier) +
            ");",
        )
        .join("\n"),
    );
    if (surface === "CLI") {
      const program = [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(import.meta.url);",
        "const requests = " +
          JSON.stringify(requests.map(({ specifier }) => specifier)) +
          ";",
        "const results = [];",
        "for (const specifier of requests) { try { const value = require(specifier); results.push({value: value?.default ?? value, error: null}); } catch(error) { results.push({value: null, error: error.code}); } }",
        "console.log(JSON.stringify(results));",
      ].join("\n");
      const response = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", program],
        { cwd: root, timeout: 5_000 },
      );
      expect(JSON.parse(response.stdout)).toEqual(
        requests.map(({ error }) => ({
          value: error === null ? 42 : null,
          error,
        })),
      );
    }
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const { specifier, target, status } of requests)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier,
            resolved_path: target,
            resolution_status: status,
          }),
        }),
      );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          specifier: "./typed-dep.cjs",
          resolved_path: "typed-dep.cts",
          resolution_status: "resolved",
        }),
      }),
    );
  },
);
