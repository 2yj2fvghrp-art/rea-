import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS } from "../../../src/domain/javascript/javascriptAnalysisResourceControls.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const largeModule = `${Array.from(
  { length: 800 },
  (_, index) =>
    `export function method_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }`,
).join("\n")}\n`;

cliTest(
  "admits an earlier generated module when one later source remains",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-admission-");
    await writeFile(join(root, "a-large.mjs"), largeModule);
    await writeFile(join(root, "z-tiny.mjs"), "export const tiny = 1;\n");
    const output = await cli.run({
      arguments: ["analyze", root, "--json"],
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
      timeoutMs: 120_000,
    });
    expect(JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.heapMb).toBe(1024);
    expect(output.exitCode).toBe(0);
    expect(output.stderr).not.toMatch(/exhausted its heap/iu);
    const evidence = output.json as {
      normalized_result?: {
        statistics?: {
          parsed_javascript_files?: number;
          parse_failures?: number;
          visited_ast_nodes?: number;
        };
        semantic_graph?: {
          nodes?: readonly {
            label?: string;
            properties?: { name?: string };
          }[];
          relations?: readonly unknown[];
          coverage?: { truncated?: boolean };
        };
      };
    };
    const result = evidence.normalized_result;
    expect(result?.statistics).toMatchObject({
      parsed_javascript_files: 2,
      parse_failures: 0,
      visited_ast_nodes: 17_609,
    });
    const nodes = result?.semantic_graph?.nodes ?? [];
    expect(
      nodes.some(
        (node) =>
          node.label === "method_0" || node.properties?.name === "method_0",
      ),
    ).toBe(true);
    expect((result?.semantic_graph?.relations ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(output.json)).not.toContain(
      "Review the reported worker memory limits",
    );
  },
  120_000,
);
