import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains configuration sources consumed by member access through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-config-reads-");
    await writeFixtureFiles(root, {
      "entry.mjs": [
        "const length = process.env.REA_ENDPOINT.length;",
        "const endpoint = process.env.REA_ENDPOINT;",
        "const argumentLength = process.argv[2].length;",
        "const mode = process.argv[3].trim();",
        "const optional = process.env.REA_MISSING?.length;",
        "function shadow(process) { return process.env.LOCAL.length + process.argv[2].length; }",
        'const local = { env: { FAKE: "fake" }, argv: [0, 1, "abc"] };',
        'const control = shadow({ env: { LOCAL: "local" }, argv: [0, 1, "abc"] });',
        "console.log(JSON.stringify([length, endpoint, argumentLength, mode, optional, control, local.env.FAKE.length]));",
      ].join("\n"),
    });
    const control = await execute(
      process.execPath,
      [join(root, "entry.mjs"), "abc", " mode "],
      { env: { REA_ENDPOINT: "endpoint" } },
    );
    expect(JSON.parse(control.stdout)).toEqual([
      8,
      "endpoint",
      3,
      "mode",
      null,
      8,
      4,
    ]);
    const graph = (await analyzeJavaScriptDirectory(surface, cli, root))
      .semantic_graph;
    const sources = graph.nodes.filter((node) => node.kind === "config-source");
    expect(
      sources
        .map((node) => [node.properties.source_kind, node.properties.key])
        .sort(),
    ).toEqual([
      ["argv", "2"],
      ["argv", "3"],
      ["environment", "REA_ENDPOINT"],
      ["environment", "REA_ENDPOINT"],
      ["environment", "REA_MISSING"],
    ]);
    expect(sources.every((node) => node.properties.value === null)).toBe(true);
  },
);
