import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { managedMemberSummaryViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "projects portable member summary and method bodies through the compiled CLI after source removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-member-view-cli-");
    const path = join(root, "fixture.dll");
    await writeFile(
      path,
      buildManagedPeFixture({ typeNamespace: "Example", typeName: "Program" }),
    );
    const inspected = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--type",
        "Example.Program",
        "--json",
      ],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const parent = parseEvidence(inspected.json);
    const report = managedMemberInspectionSchema.parse(
      parent.normalized_result,
    );
    expect(report.methods).toHaveLength(1);
    await unlink(path);
    const requestPath = join(root, "view.json");
    for (const view of [
      { kind: "summary" },
      { kind: "managed-members", collection: "methods", offset: 0, limit: 1 },
    ]) {
      const input = { source: { kind: "inline", evidence: parent }, view };
      // Pass large Evidence through a file, never a command-line argument.
      await writeFile(requestPath, JSON.stringify(input));
      const projected = await cli.run({
        arguments: ["inspect-analysis-view", requestPath, "--json"],
      });
      expect(projected.exitCode, projected.stderr).toBe(0);
      const evidence = parseEvidence(projected.json);
      const portable = inspectAnalysisView(input);
      if (!portable.ok) throw portable.error;
      expect(evidence.normalized_result).toEqual(
        portable.value.normalized_result,
      );
      expect(evidence.evidence_links).toEqual([parent.evidence_id]);
      if (view.kind === "summary") {
        const summary = managedMemberSummaryViewResultSchema.parse(
          evidence.normalized_result,
        ).summary;
        expect(summary.selection).toEqual(report.selection);
        expect(summary.reported_counts.methods).toBe(1);
      } else
        expect(evidence.normalized_result).toMatchObject({
          item: report.methods,
        });
    }
  },
  // Includes three fresh CLI processes and a cold compile-cache population.
  60000,
);
