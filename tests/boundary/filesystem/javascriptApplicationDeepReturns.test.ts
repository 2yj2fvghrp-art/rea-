import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("analyzes direct returns after deep source without exhausting the default process stack", async () => {
  const root = await createTestTempDirectory("rea-deep-direct-returns-");
  await writeFile(
    join(root, "app.js"),
    `export function render() { object${".property".repeat(20_000)}; function nested() { return "nested"; } class Inner { method() { return "method"; } } return "ready"; }`,
  );
  const entrypoint = fileURLToPath(
    new URL("../../../scripts/rea.mjs", import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "analyze-javascript-application",
      root,
      "--artifact-format",
      "directory",
      "--format",
      "json",
    ],
    {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      // Bound the child heap while retaining Node's default stack size.
      env: {
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        NODE_OPTIONS: "--max-old-space-size=768",
      },
    },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  const owners = result.semantic_graph.nodes
    .filter((node) => node.kind === "return-site")
    .map((node) => node.function_node_id);
  expect(owners).toHaveLength(3);
  expect(new Set(owners).size).toBe(3);
});
