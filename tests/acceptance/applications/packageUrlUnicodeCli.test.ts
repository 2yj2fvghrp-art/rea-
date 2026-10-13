import { createPackageWithOptions } from "@electron/asar";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const requests = ["legacy/feature.js", "mapped/feature", "#feature"];
const source = requests
  .map((specifier) => `import ${JSON.stringify(specifier)};`)
  .join("\n");

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains unrepresentable package URL paths as unavailable through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-url-unicode-");
    const application = join(root, "application");
    await mkdir(application);
    const fixture = join(root, "source");
    const prefixes = ["highxx", "lowxxx", "valid\ud83d\ude00"];
    for (const prefix of prefixes)
      await writeFixtureFiles(join(fixture, prefix), {
        "main.mjs": source,
        "package.json": JSON.stringify({
          imports: { "#feature": "./feature.js" },
        }),
        "feature.js": "export default 1;",
        "node_modules/legacy/package.json": "{}",
        "node_modules/legacy/feature.js": "export default 2;",
        "node_modules/mapped/package.json": JSON.stringify({
          exports: { "./feature": "./feature.js" },
        }),
        "node_modules/mapped/feature.js": "export default 3;",
      });
    const archive = join(application, "app.asar");
    await createPackageWithOptions(fixture, archive, {});
    const bytes = await readFile(archive);
    const header = bytes.subarray(16, 16 + bytes.readUInt32LE(12));
    const escaped = Buffer.from(
      header
        .toString("utf8")
        .replace('"highxx":', '"\\ud800":')
        .replace('"lowxxx":', '"\\udc00":'),
    );
    expect(escaped.length).toBe(header.length);
    expect(escaped.equals(header)).toBe(false);
    escaped.copy(bytes, 16);
    await writeFile(archive, bytes);

    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    for (const prefix of ["\ud800", "\udc00", "valid\ud83d\ude00"])
      for (const [index, specifier] of requests.entries()) {
        const base = `app.asar/${prefix}`;
        const target = [
          `${base}/node_modules/legacy/feature.js`,
          `${base}/node_modules/mapped/feature.js`,
          `${base}/feature.js`,
        ][index];
        const available = prefix.startsWith("valid");
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              module_link_kind: "import",
              specifier,
              resolution_status: available ? "resolved" : "unavailable",
              resolved_path: available ? target : null,
            }),
            evidence: expect.objectContaining({
              ...(available
                ? {}
                : {
                    limitations: expect.arrayContaining([
                      expect.stringContaining("unpaired UTF-16 surrogate"),
                    ]),
                  }),
              artifact: expect.objectContaining({
                sha256: createHash("sha256").update(source).digest("hex"),
              }),
              location: expect.objectContaining({
                value: expect.objectContaining({ source: `${base}/main.mjs` }),
              }),
            }),
          }),
        );
      }
    expect(await readFile(archive)).toEqual(bytes);
  },
);
