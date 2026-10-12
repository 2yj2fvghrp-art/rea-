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
    specifier: "./extensionless",
    target: null,
    status: "not-found",
    error: "ERR_MODULE_NOT_FOUND",
  },
  {
    specifier: "./directory",
    target: null,
    status: "not-found",
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "./missing.js",
    target: null,
    status: "not-found",
    error: "ERR_MODULE_NOT_FOUND",
  },
  {
    specifier: "./actual.cjs?cache=1",
    target: "actual.cjs",
    status: "resolved",
    error: null,
  },
];
cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps relative ESM lookup exact through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-esm-exact-");
    const files = {
      "extensionless.js": "module.exports=42;",
      "directory/index.js": "module.exports=42;",
      "missing.js.js": "module.exports=42;",
      "actual.cjs": "module.exports=42;",
      "typed.ts": 'import value from "./typed-dep.js";',
      "typed-dep.ts": "export default 42;",
      "legacy.cjs":
        'const value=require("./legacy-dep"); module.exports=value;',
      "legacy-dep.js": "module.exports=42;",
    };
    for (const [path, text] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
    }
    await writeFile(
      join(root, "entry.mjs"),
      requests
        .map(
          ({ specifier }, index) =>
            "import value" + index + " from " + JSON.stringify(specifier) + ";",
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
        "for (const specifier of requests) { try { const value = await import(specifier); results.push({value: value?.default ?? value, error: null}); } catch(error) { results.push({value: null, error: error.code}); } }",
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
    for (const [specifier, target] of [
      ["./typed-dep.js", "typed-dep.ts"],
      ["./legacy-dep", "legacy-dep.js"],
    ])
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier,
            resolved_path: target,
            resolution_status: "resolved",
          }),
        }),
      );
  },
);
