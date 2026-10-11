import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const declarations = Array.from(
  { length: 800 },
  (_, index) =>
    `export function method_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }\n`,
).join("");

const outputSchema = z.object({
  normalized_result: z.object({
    semantic_graph: z.object({ nodes: z.array(z.unknown()) }),
  }),
});

// Bun ignores V8 heap flags, so only Node.js can bound the nested CLI's
// parent heap to the capacity this scenario needs.
cliTest.skipIf(process.versions.bun !== undefined)(
  "keeps an earlier semantic graph when only one small source remains",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-static-reserve-");
    await Promise.all([
      writeFile(join(root, "a-large.mjs"), declarations),
      writeFile(join(root, "z-tiny.mjs"), "export const tiny = 1;\n"),
    ]);

    // A bounded parent heap makes the result budget, not the worker, decide
    // admission. One remaining source needs only one checkpoint's reserve.
    const output = await cli.run({
      arguments: ["analyze", root, "--format", "json"],
      environment: { NODE_OPTIONS: "--max-old-space-size=800" },
      timeoutMs: 120_000,
    });

    expect(output.exitCode).toBe(0);
    expect(output.stdout).not.toContain(
      "Semantic graph for a-large.mjs exceeds the parent's remaining result budget",
    );
    const graph = outputSchema.parse(output.json).normalized_result
      .semantic_graph;
    expect(
      graph.nodes.some((node) => JSON.stringify(node).includes("method_0")),
    ).toBe(true);
  },
  180_000,
);
