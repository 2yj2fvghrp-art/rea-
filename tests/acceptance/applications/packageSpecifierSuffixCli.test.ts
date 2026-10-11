import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const requests = [
  {
    specifier: "fixture/feature?cache=1",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "fixture/feature#entry",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "fixture/literal?cache=1",
    target: "node_modules/fixture/literal.cjs",
    status: "resolved",
    value: "literal",
    error: null,
  },
  {
    specifier: "legacy/?cache=1",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/#entry",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/nested/?cache=1",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/nested/#entry",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/feature.js",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/feature.js?cache=1",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/feature.js#entry",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/with%20space.js?cache=1",
    target: "node_modules/legacy/with space.js",
    status: "resolved",
    value: "legacy spaced feature",
    error: null,
  },
  {
    specifier: "legacy/feature",
    target: null,
    status: "not-found",
    value: null,
    error: "ERR_MODULE_NOT_FOUND",
  },
];

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps bare package query and fragment keys exact through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-specifier-suffix-");
    const packagePath = join(root, "node_modules", "fixture");
    const legacyPackagePath = join(root, "node_modules", "legacy");
    await Promise.all([
      mkdir(packagePath, { recursive: true }),
      mkdir(join(legacyPackagePath, "nested"), { recursive: true }),
    ]);
    await writeFile(
      join(packagePath, "package.json"),
      JSON.stringify({
        exports: {
          "./feature": "./feature.cjs",
          "./literal?cache=1": "./literal.cjs",
        },
      }),
    );
    await writeFile(
      join(packagePath, "feature.cjs"),
      'module.exports = "feature";',
    );
    await writeFile(
      join(packagePath, "literal.cjs"),
      'module.exports = "literal";',
    );
    await Promise.all([
      writeFile(
        join(legacyPackagePath, "package.json"),
        JSON.stringify({ name: "legacy", main: "./main.cjs" }),
      ),
      writeFile(
        join(legacyPackagePath, "main.cjs"),
        'module.exports = "legacy root";',
      ),
      writeFile(
        join(legacyPackagePath, "feature.js"),
        'module.exports = "legacy feature";',
      ),
      writeFile(
        join(legacyPackagePath, "with space.js"),
        'module.exports = "legacy spaced feature";',
      ),
      writeFile(
        join(legacyPackagePath, "nested", "package.json"),
        JSON.stringify({ main: "./main.cjs" }),
      ),
      writeFile(
        join(legacyPackagePath, "nested", "main.cjs"),
        'module.exports = "legacy nested";',
      ),
    ]);

    await writeFile(
      join(root, "main.mjs"),
      requests
        .map(
          ({ specifier }, index) =>
            `import value${index} from ${JSON.stringify(specifier)};`,
        )
        .join("\n"),
    );
    if (surface === "CLI") {
      const native = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const requests = ${JSON.stringify(requests.map(({ specifier }) => specifier))};
          const results = await Promise.all(requests.map(async (specifier) => {
            try {
              const result = await import(specifier);
              return { value: result.default, error: null };
            } catch (error) {
              return { value: null, error: error.code };
            }
          }));
          console.log(JSON.stringify(results));`,
        ],
        { cwd: root, timeout: 5_000 },
      );
      expect(JSON.parse(native.stdout)).toEqual(
        requests.map(({ value, error }) => ({ value, error })),
      );
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
    for (const { specifier, target, status } of requests)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: "import",
            specifier,
            resolved_path: target,
            resolution_status: status,
          }),
        }),
      );
  },
);
