import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves ESM package self exports with import conditions through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-esm-self-exports-");
    const source = [
      'import rootValue from "rea-self-fixture";',
      'import feature from "rea-self-fixture/feature";',
      'import punctuated from "rea-self-fixture/feature?cache=1";',
      'import missingQuery from "rea-self-fixture/feature?cache=2";',
      'import missingFragment from "rea-self-fixture/feature#entry";',
      "console.log(rootValue, feature, punctuated, missingQuery, missingFragment);",
    ].join("\n");
    const files = {
      "package.json": JSON.stringify({
        name: "rea-self-fixture",
        exports: {
          ".": { import: "./root.cjs", require: "./require.cjs" },
          "./feature": { import: "./feature.cjs", require: "./require.cjs" },
          "./feature?cache=1": {
            import: "./punctuated.cjs",
            require: "./require.cjs",
          },
        },
      }),
      "main.mjs": source,
      "root.cjs": "module.exports = 11;",
      "feature.cjs": "module.exports = 22;",
      "punctuated.cjs": "module.exports = 33;",
      "require.cjs": "module.exports = -1;",
    };
    await Promise.all(
      Object.entries(files).map(([path, text]) =>
        writeFile(join(root, path), text),
      ),
    );
    if (surface === "CLI") {
      const native = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const requests = ${JSON.stringify([
            "rea-self-fixture",
            "rea-self-fixture/feature",
            "rea-self-fixture/feature?cache=1",
            "rea-self-fixture/feature?cache=2",
            "rea-self-fixture/feature#entry",
          ])};
          const results = await Promise.all(requests.map(async (specifier) => {
            try {
              const loaded = await import(specifier);
              return { value: loaded.default, error: null };
            } catch (error) {
              return { value: null, error: error.code };
            }
          }));
          console.log(JSON.stringify(results));`,
        ],
        { cwd: root, timeout: 5_000 },
      );
      expect(JSON.parse(native.stdout)).toEqual([
        { value: 11, error: null },
        { value: 22, error: null },
        { value: 33, error: null },
        { value: null, error: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        { value: null, error: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
      ]);
    }

    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--format", "json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
        format: "directory",
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(document).normalized_result;
    for (const [specifier, path] of [
      ["rea-self-fixture", "root.cjs"],
      ["rea-self-fixture/feature", "feature.cjs"],
      ["rea-self-fixture/feature?cache=1", "punctuated.cjs"],
    ])
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: "import",
            specifier,
            resolved_path: path,
            resolution_status: "resolved",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              sha256: createHash("sha256").update(source).digest("hex"),
            }),
            location: expect.objectContaining({
              value: expect.objectContaining({ source: "main.mjs" }),
            }),
          }),
        }),
      );
    for (const specifier of [
      "rea-self-fixture/feature?cache=2",
      "rea-self-fixture/feature#entry",
    ])
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: "import",
            specifier,
            resolved_path: null,
            resolution_status: "external",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              sha256: createHash("sha256").update(source).digest("hex"),
            }),
            location: expect.objectContaining({
              value: expect.objectContaining({ source: "main.mjs" }),
            }),
          }),
        }),
      );
  },
);
