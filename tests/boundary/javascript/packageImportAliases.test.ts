import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  resolveArtifactPathByContext,
  type ArtifactPathResolution,
} from "../../../src/application/javascript/JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const nodeOutcomeSchema = z.strictObject({
  target: z.string().nullable(),
  error_code: z.string().nullable(),
});

const posixRelative = (root: string, absolute: string): string =>
  relative(root, absolute).replaceAll("\\", "/");

const inventory = (
  contents: ReadonlyMap<string, string>,
): Map<string, JavaScriptArtifactFile> =>
  new Map(
    [...contents].map(([path, value]) => [
      path,
      {
        path,
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(value),
        inventory_artifact_id: path,
        kind: path.endsWith("package.json") ? "package-json" : "javascript",
        unpacked: false,
        text: { included: true, value },
      },
    ]),
  );

const writeTree = async (
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();
  await Promise.all(
    Object.entries(files).map(async ([path, value]) => {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, value);
      contents.set(path, value);
    }),
  );
  return contents;
};

const nodeRequireTarget = async (
  importer: string,
  specifier: string,
): Promise<z.infer<typeof nodeOutcomeSchema>> => {
  try {
    return {
      target: createRequire(importer).resolve(specifier),
      error_code: null,
    };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? z.string().parse(Reflect.get(error, "code"))
        : null;
    return { target: null, error_code: code };
  }
};

const nodeImportTarget = async (
  cwd: string,
  specifier: string,
): Promise<z.infer<typeof nodeOutcomeSchema>> => {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      try {
        const url = await import.meta.resolve(${JSON.stringify(specifier)});
        console.log(JSON.stringify({ target: url, error_code: null }));
      } catch (error) {
        console.log(JSON.stringify({
          target: null,
          error_code: error.code ?? null,
        }));
      }
    `,
    ],
    { cwd },
  );
  return nodeOutcomeSchema.parse(JSON.parse(stdout));
};

const resolveAlias = (
  files: Map<string, JavaScriptArtifactFile>,
  declaredPath: string,
  sourcePath: string,
  moduleKind: "import" | "require",
): ArtifactPathResolution =>
  resolveArtifactPathByContext({
    declaredPath,
    sourcePath,
    context: "module-specifier",
    moduleKind,
    files,
  });

describe("literal package import keys compared with Node", () => {
  it("matches literal imports keys containing path-like bytes in both Node loaders", async () => {
    const root = await createTestTempDirectory("rea-import-alias-literal-");
    const specifiers = ["#x%2Fy", "#x%2Ey", "#x\\y", "#x\0y"];
    const contents = await writeTree(root, {
      "package.json": JSON.stringify({
        imports: Object.fromEntries(
          specifiers.map((specifier) => [specifier, "./target.cjs"]),
        ),
      }),
      "main.cjs": "module.exports = 1;",
      "target.cjs": "module.exports = 1;",
    });
    const inventoried = inventory(contents);
    for (const specifier of specifiers) {
      const required = await nodeRequireTarget(
        join(root, "main.cjs"),
        specifier,
      );
      expect(required.error_code).toBeNull();
      expect(posixRelative(root, required.target ?? "")).toBe("target.cjs");
      const imported = await nodeImportTarget(root, specifier);
      expect(imported.error_code).toBeNull();
      expect(posixRelative(root, fileURLToPath(imported.target ?? ""))).toBe(
        "target.cjs",
      );
      for (const moduleKind of ["require", "import"] as const)
        expect(
          resolveAlias(inventoried, specifier, "main.cjs", moduleKind),
          JSON.stringify({ specifier, moduleKind }),
        ).toMatchObject({
          declared_path: specifier,
          resolution_status: "resolved",
          resolved_path: "target.cjs",
        });
    }
  });

  it("still rejects unsafe selected targets for literal imports keys", async () => {
    const root = await createTestTempDirectory("rea-import-alias-target-");
    const contents = await writeTree(root, {
      "package.json": JSON.stringify({
        imports: { "#x%2Fy": "./nested%2Ftarget.cjs" },
      }),
      "main.cjs": "module.exports = 1;",
      "nested/target.cjs": "module.exports = 1;",
    });
    const inventoried = inventory(contents);
    const required = await nodeRequireTarget(join(root, "main.cjs"), "#x%2Fy");
    expect(required.error_code).toBe("ERR_INVALID_MODULE_SPECIFIER");
    const imported = await nodeImportTarget(root, "#x%2Fy");
    expect(imported.error_code).toBe("ERR_INVALID_MODULE_SPECIFIER");
    for (const moduleKind of ["require", "import"] as const)
      expect(
        resolveAlias(inventoried, "#x%2Fy", "main.cjs", moduleKind),
      ).toMatchObject({ resolution_status: "rejected", resolved_path: null });
  });
});

describe("package import aliases compared with Node", () => {
  it("matches Node require and import for an exact root alias", async () => {
    const root = await createTestTempDirectory("rea-import-alias-root-");
    const files = {
      "package.json": JSON.stringify({
        name: "app",
        imports: { "#config": "./config.cjs" },
      }),
      "main.cjs": 'module.exports = require("#config");',
      "config.cjs": "module.exports = 'config.cjs';",
    };
    const contents = await writeTree(root, files);
    const inventoried = inventory(contents);
    const required = await nodeRequireTarget(join(root, "main.cjs"), "#config");
    expect(posixRelative(root, required.target ?? "")).toBe("config.cjs");
    expect(
      resolveAlias(inventoried, "#config", "main.cjs", "require"),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.cjs",
    });
    const imported = await nodeImportTarget(root, "#config");
    expect(imported.error_code).toBeNull();
    expect(
      resolveAlias(inventoried, "#config", "main.cjs", "import"),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.cjs",
    });
  });

  it("matches Node when a nested package has its own imports map", async () => {
    const root = await createTestTempDirectory("rea-import-alias-nested-");
    const files = {
      "package.json": JSON.stringify({
        name: "app",
        imports: { "#config": "./root.cjs" },
      }),
      "root.cjs": "module.exports = 'root';",
      "node_modules/fixture/package.json": JSON.stringify({
        name: "fixture",
        imports: { "#config": "./local.cjs" },
      }),
      "node_modules/fixture/index.cjs": 'module.exports = require("#config");',
      "node_modules/fixture/local.cjs": "module.exports = 'local';",
    };
    const contents = await writeTree(root, files);
    const inventoried = inventory(contents);
    const nested = await nodeRequireTarget(
      join(root, "node_modules/fixture/index.cjs"),
      "#config",
    );
    expect(posixRelative(root, nested.target ?? "")).toBe(
      "node_modules/fixture/local.cjs",
    );
    expect(
      resolveAlias(
        inventoried,
        "#config",
        "node_modules/fixture/index.cjs",
        "require",
      ),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "node_modules/fixture/local.cjs",
    });
    const fromRoot = await nodeRequireTarget(join(root, "root.cjs"), "#config");
    expect(posixRelative(root, fromRoot.target ?? "")).toBe("root.cjs");
    expect(
      resolveAlias(inventoried, "#config", "root.cjs", "require"),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "root.cjs",
    });
  });

  it("matches Node when a nested package does not define the alias", async () => {
    const root = await createTestTempDirectory("rea-import-alias-scope-");
    const files = {
      "package.json": JSON.stringify({
        name: "app",
        imports: { "#config": "./root.cjs" },
      }),
      "root.cjs": "module.exports = 'root';",
      "node_modules/fixture/package.json": JSON.stringify({
        name: "fixture",
      }),
      "node_modules/fixture/index.cjs": 'module.exports = require("#config");',
    };
    await writeTree(root, files);
    const nested = await nodeRequireTarget(
      join(root, "node_modules/fixture/index.cjs"),
      "#config",
    );
    expect(nested.target).toBeNull();
    // CJS reports MODULE_NOT_FOUND when the nested package.json has no
    // `imports` field at all; it still does not inherit the ancestor map.
    expect(nested.error_code).toBe("MODULE_NOT_FOUND");
    const outcome = resolveAlias(
      inventory(new Map(Object.entries(files))),
      "#config",
      "node_modules/fixture/index.cjs",
      "require",
    );
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain(
      "node_modules/fixture/package.json",
    );
  });
});

describe("package import alias refusals compared with Node", () => {
  it("matches Node refusal for a missing key, explicit null, and reserved specifier", async () => {
    const root = await createTestTempDirectory("rea-import-alias-refuse-");
    const files = {
      "package.json": JSON.stringify({
        name: "app",
        imports: { "#config": "./config.cjs", "#blocked": null },
      }),
      "main.cjs": "module.exports = 1;",
      "config.cjs": "module.exports = 1;",
    };
    await writeTree(root, files);
    const inventoried = inventory(new Map(Object.entries(files)));
    const missing = await nodeRequireTarget(join(root, "main.cjs"), "#missing");
    expect(missing.error_code).toBe("ERR_PACKAGE_IMPORT_NOT_DEFINED");
    expect(
      resolveAlias(inventoried, "#missing", "main.cjs", "require"),
    ).toMatchObject({ resolution_status: "external", resolved_path: null });
    const blocked = await nodeRequireTarget(join(root, "main.cjs"), "#blocked");
    expect(blocked.error_code).toBe("ERR_PACKAGE_IMPORT_NOT_DEFINED");
    expect(
      resolveAlias(inventoried, "#blocked", "main.cjs", "require"),
    ).toMatchObject({ resolution_status: "external", resolved_path: null });
    const reserved = await nodeRequireTarget(join(root, "main.cjs"), "#");
    expect(reserved.error_code).toBe("ERR_INVALID_MODULE_SPECIFIER");
    expect(resolveAlias(inventoried, "#", "main.cjs", "require")).toMatchObject(
      { resolution_status: "rejected", resolved_path: null },
    );
  });

  it("matches Node when an import condition selects a different exact file", async () => {
    const root = await createTestTempDirectory("rea-import-alias-cond-");
    const files = {
      "package.json": JSON.stringify({
        name: "app",
        type: "module",
        imports: {
          "#config": {
            import: "./config.mjs",
            require: "./config.cjs",
          },
        },
      }),
      "main.cjs": 'module.exports = require("#config");',
      "config.cjs": "export default 'cjs'; module.exports = 'cjs';",
      "config.mjs": "export default 'mjs';",
    };
    await writeTree(root, files);
    const inventoried = inventory(new Map(Object.entries(files)));
    const required = await nodeRequireTarget(join(root, "main.cjs"), "#config");
    expect(posixRelative(root, required.target ?? "")).toBe("config.cjs");
    expect(
      resolveAlias(inventoried, "#config", "main.cjs", "require"),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.cjs",
    });
    const imported = await nodeImportTarget(root, "#config");
    expect(imported.error_code).toBeNull();
    expect(imported.target ?? "").toContain("config.mjs");
    expect(
      resolveAlias(inventoried, "#config", "main.cjs", "import"),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.mjs",
    });
  });
});
