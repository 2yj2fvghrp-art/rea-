import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "function fingerprint seeds distinguish syntax while retaining duplicate ambiguity through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-function-fingerprints-");
    const application = join(root, "application");
    await mkdir(application);
    await writeFile(
      join(application, "app.mjs"),
      `
    throw new Error("This analysis fixture must not execute");
    export function postfix(value) { return value++; }
    export function prefix(value) { return ++value; }
    export function renamed(item) { return item++ ; }
    export function* plain(values) { yield values; }
    export function* delegated(values) { yield* values; }
    export function* renamedGenerator(items) { yield items ; }
  `,
    );
    const analyzed = await cli.run({
      arguments: [
        "analyze-javascript-application",
        application,
        "--artifact-format",
        "directory",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(analyzed.exitCode, analyzed.stderr).toBe(0);
    const evidence = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(analyzed.json);
    const { semantic_graph: graph } =
      javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      );
    const { client, call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: application,
      format: "directory",
    });
    expect(response.isError).not.toBe(true);
    const retained = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(response.structuredContent);
    expect(retained.evidence_id).toBe(evidence.evidence_id);
    const fingerprint = (name: string) => {
      const node = graph.nodes.find(
        (candidate) =>
          candidate.kind === "function" && candidate.properties.name === name,
      );
      if (node === undefined) throw new Error(`Missing function ${name}`);
      const result = graph.fingerprints.find(
        ({ function_node_id }) => function_node_id === node.node_id,
      );
      if (result === undefined) throw new Error(`Missing fingerprint ${name}`);
      expect(result.status).toBe("complete");
      return result;
    };
    for (const [selected, expectedNames] of [
      ["postfix", ["postfix", "renamed"]],
      ["prefix", ["prefix"]],
      ["plain", ["plain", "renamedGenerator"]],
      ["delegated", ["delegated"]],
    ] as const) {
      const query = {
        seed: {
          kind: "function",
          fingerprint_sha256: fingerprint(selected).fingerprint_sha256,
        },
        direction: "forward-influence",
      };
      const traced = await call("trace_javascript_semantics", {
        application: {
          kind: "retained-evidence",
          evidence_id: retained.evidence_id,
        },
        query,
      });
      expect(traced.isError, JSON.stringify(traced)).not.toBe(true);
      const traceEvidence = toolContract(
        "trace_javascript_semantics",
      ).outputSchema.parse(traced.structuredContent);
      const trace = javaScriptSemanticTraceResultSchema.parse(
        traceEvidence.normalized_result,
      );
      expect(trace.seed_node_ids).toEqual(
        expectedNames.map((name) => fingerprint(name).function_node_id).sort(),
      );
      expect(trace.status).toBe(
        expectedNames.length > 1 ? "ambiguous" : "found",
      );
      expect(trace.source_graph_id).toBe(graph.graph_id);
      if (selected === "prefix") {
        const requestPath = join(root, "trace-request.json");
        await writeFile(
          requestPath,
          JSON.stringify({ application: evidence, query }),
        );
        const cliTrace = await cli.run({
          arguments: ["trace-javascript-semantics", requestPath, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(cliTrace.exitCode, cliTrace.stderr).toBe(0);
        const cliEvidence = toolContract(
          "trace_javascript_semantics",
        ).outputSchema.parse(cliTrace.json);
        expect(cliEvidence.evidence_id).toBe(traceEvidence.evidence_id);
      }
    }
    await client.ping();
  },
);
