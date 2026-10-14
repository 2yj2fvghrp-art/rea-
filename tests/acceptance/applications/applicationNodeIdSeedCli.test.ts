import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "honors node-ID seed options through the compiled feature trace CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-node-id-seed-");
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "sample-app",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    await writeFile(
      join(app, "index.js"),
      'module.exports = function greet() { return "hello"; };\n',
    );
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", app, "--json"],
    });
    expect(analyzed.exitCode, analyzed.stderr).toBe(0);
    const application = parseEvidence(analyzed.json);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      application.normalized_result,
    );
    expect(graph.coverage.status).toBe("complete");
    const node = graph.nodes[0];
    if (node === undefined) throw new Error("Expected an analyzed graph node");
    const id = node.node_id;
    const prefix = id.slice(0, -1);
    expect(
      graph.nodes.filter(({ node_id }) => node_id.startsWith(prefix)),
    ).toHaveLength(1);
    const cases = [
      ["prefix-contains", prefix, "contains", false, [id]],
      ["full-contains", id, "contains", true, [id]],
      ["upper-contains", prefix.toUpperCase(), "contains", false, [id]],
      ["upper-exact", id.toUpperCase(), "exact", false, [id]],
      ["default-options", id.toUpperCase(), undefined, undefined, [id]],
      ["full-exact", id, "exact", true, [id]],
      ["upper-case-sensitive", id.toUpperCase(), "exact", true, []],
      ["prefix-default-exact", prefix, undefined, undefined, []],
      ["label-is-not-id", "greet", "contains", false, []],
      [
        "all-node-ids",
        "jag_node_",
        "contains",
        true,
        graph.nodes.map(({ node_id }) => node_id),
      ],
    ] as const;
    const request = join(root, "trace.json");
    for (const [name, value, match, caseSensitive, expectedIds] of cases) {
      await writeFile(
        request,
        JSON.stringify({
          application,
          direction: "both",
          seed: {
            kind: "node-id",
            value,
            match,
            case_sensitive: caseSensitive,
          },
        }),
      );
      const response = await cli.run({
        arguments: ["trace-application-feature", request, "--json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const result = applicationFeatureTraceResultSchema.parse(
        parseEvidence(response.json).normalized_result,
      );
      expect.soft(result.seed_matches, name).toEqual(
        [...expectedIds].sort().map((nodeId) => ({
          node_id: nodeId,
          kind: graph.nodes.find(({ node_id }) => node_id === nodeId)?.kind,
          basis: "node-id",
          field: "node_id",
        })),
      );
      expect.soft(result.summary.matched_seeds, name).toBe(expectedIds.length);
      expect
        .soft(result.coverage.status, name)
        .toBe(expectedIds.length === 0 ? "no-match" : "complete-within-source");
    }
  },
);
