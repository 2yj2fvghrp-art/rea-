import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  analysisViewResultSchema,
  managedMemberSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { managedMemberViewRequestSchema } from "../../../src/domain/analysisView/managedMemberView.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const verifyMemberPages = async ({
  client,
  parent,
  report,
  summary,
  ajv,
  viewOutputSchema,
}: {
  client: Client;
  parent: ReturnType<typeof parseEvidence>;
  report: ReturnType<typeof managedMemberInspectionSchema.parse>;
  summary: ReturnType<typeof managedMemberSummaryViewResultSchema.parse>;
  ajv: Ajv2020;
  viewOutputSchema: Record<string, unknown>;
}) => {
  for (const collection of managedMemberViewRequestSchema.shape.collection
    .options) {
    const expected =
      collection === "user_strings"
        ? (report.user_strings?.literals ?? null)
        : report[collection];
    expect(summary.summary.reported_counts[collection]).toBe(
      expected?.length ?? null,
    );
    const rows: unknown[] = [];
    let offset = 0;
    for (;;) {
      const request = {
        source: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
        view: { kind: "managed-members", collection, offset, limit: 1 },
      };
      const pageReply = await client.callTool({
        name: "inspect_analysis_view",
        arguments: request,
      });
      expect(pageReply.isError).not.toBe(true);
      expect(
        ajv.validate(viewOutputSchema, pageReply.structuredContent),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const page = analysisViewResultSchema.parse(
        parseEvidence(pageReply.structuredContent).normalized_result,
      );
      if (page.kind !== "managed-members") throw new Error("Unexpected page");
      expect(page.item).toEqual(expected?.slice(offset, offset + 1) ?? null);
      expect(page.source_coverage).toEqual(report.coverage);
      expect(page.identity_scope).toEqual(report.identity_scope);
      expect(page.selection).toEqual(report.selection);
      expect(page.source_collection_available).toBe(expected !== null);
      const portable = inspectAnalysisView({
        ...request,
        source: { kind: "inline", evidence: parent },
      });
      if (!portable.ok) throw portable.error;
      expect(portable.value.normalized_result).toEqual(page);
      rows.push(...(page.item ?? []));
      if (page.coverage.next_offset === null) break;
      offset = page.coverage.next_offset;
    }
    expect(rows).toEqual(expected ?? []);
  }
  for (const view of [
    { kind: "managed-members", collection: "methods", offset: -1 },
    { kind: "managed-members", collection: "methods", limit: 0 },
    { kind: "managed", collection: "references" },
  ]) {
    const invalid = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
        view,
      },
    });
    expect(invalid.isError).toBe(true);
  }
};

it.each([{ typeNames: ["Example.Program"] }, { typeNames: ["Missing.Type"] }])(
  "retains and reconstructs selected member rows for %j through SDK schemas and portable Evidence",
  async ({ typeNames }) => {
    const directory = await createTestTempDirectory("rea-member-summary-");
    const path = join(directory, "fixture.dll");
    // ldstr 0x70000001; pop; call 0x0a000001; ret. #US contains one literal.
    const il = Buffer.from([
      0x72, 1, 0, 0, 0x70, 0x26, 0x28, 1, 0, 0, 0x0a, 0x2a,
    ]);
    await writeFile(
      path,
      buildManagedPeFixture({
        typeNamespace: "Example",
        typeName: "Program",
        methodRowCount: 3,
        ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
        userStringHeap: Buffer.from([0, 3, 0x41, 0, 0]),
        exportedTypes: [
          {
            namespace: "External",
            name: "Forwarded",
            flags: 0x00200000,
            implementationRaw: 5,
          },
        ],
      }),
    );
    const { client, session, close } = await createApplicationMcpHarness();
    onTestFinished(close);
    const catalog = (await client.listTools()).tools;
    const definition = catalog.find(
      (x) => x.name === "inspect_managed_members",
    )!;
    const viewDefinition = catalog.find(
      (x) => x.name === "inspect_analysis_view",
    )!;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const outputSchema: Record<string, unknown> = definition.outputSchema!;
    const viewOutputSchema: Record<string, unknown> =
      viewDefinition.outputSchema!;
    expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    expect(ajv.validateSchema(viewDefinition.inputSchema)).toBe(true);
    expect(ajv.validateSchema(viewOutputSchema)).toBe(true);
    const reply = await client.callTool({
      name: "inspect_managed_members",
      arguments: { path, type_names: typeNames, detail: "summary" },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      ajv.validate(outputSchema, reply.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const receipt = parseEvidence(reply.structuredContent);
    const summary = managedMemberSummaryViewResultSchema.parse(
      receipt.normalized_result,
    );
    const parent = session.evidenceById(summary.parent_evidence_id)!;
    const original = JSON.stringify(parent);
    const report = managedMemberInspectionSchema.parse(
      parent.normalized_result,
    );
    expect(receipt.evidence_links).toEqual([parent.evidence_id]);
    expect(receipt.evidence_id).not.toBe(parent.evidence_id);
    expect(parent.parameters).toEqual({
      path,
      type_names: typeNames,
      detail: "summary",
    });
    expect(summary.summary.selection).toEqual({
      type_names: typeNames,
      unmatched_type_names: typeNames[0] === "Missing.Type" ? typeNames : [],
    });
    expect(summary.summary.identity_scope).toEqual(report.identity_scope);
    expect(summary.summary.coverage).toEqual(report.coverage);
    expect(summary.summary.metadata).toEqual(report.metadata);
    expect(summary.summary).not.toHaveProperty("methods");
    expect(summary.summary).not.toHaveProperty("member_refs");
    expect(summary.summary.user_strings).toEqual(
      report.user_strings === null
        ? null
        : {
            state: report.user_strings.state,
            issues: report.user_strings.issues,
          },
    );
    expect(report.member_refs.length).toBeGreaterThan(0);
    if (typeNames[0] !== "Missing.Type") {
      expect(report.methods).toHaveLength(3);
      expect(report.user_strings?.literals).toHaveLength(1);
      expect(report.call_edges.length).toBeGreaterThan(0);
    }
    for (const detail of [undefined, "complete"]) {
      const complete = await client.callTool({
        name: "inspect_managed_members",
        arguments: {
          path,
          type_names: typeNames,
          ...(detail === undefined ? {} : { detail }),
        },
      });
      expect(complete.isError).not.toBe(true);
      expect(
        parseEvidence(complete.structuredContent).normalized_result,
      ).toEqual(parent.normalized_result);
    }
    const reused = await client.callTool({
      name: "inspect_managed_members",
      arguments: { type_names: typeNames, detail: "summary" },
    });
    expect(reused.isError).not.toBe(true);
    expect(parseEvidence(reused.structuredContent).subject).toEqual(
      parent.subject,
    );
    await unlink(path);
    await verifyMemberPages({
      client,
      parent,
      report,
      summary,
      ajv,
      viewOutputSchema,
    });
    expect(JSON.stringify(session.evidenceById(parent.evidence_id))).toBe(
      original,
    );
    const bundle = session.exportEvidenceBundle();
    expect(
      bundle.records.find((x) => x.evidence_id === parent.evidence_id),
    ).toEqual(parent);
    const imported = await createApplicationMcpHarness();
    onTestFinished(imported.close);
    expect(
      imported.session.importEvidenceBundle(JSON.parse(JSON.stringify(bundle)))
        .ok,
    ).toBe(true);
    const restored = await imported.client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "summary" },
      },
    });
    expect(restored.isError).not.toBe(true);
    expect(parseEvidence(restored.structuredContent).normalized_result).toEqual(
      summary,
    );
  },
  30000,
);

it("preserves malformed and historical unexamined member collections as unknown", async () => {
  const directory = await createTestTempDirectory("rea-member-partial-");
  const path = join(directory, "malformed.dll");
  await writeFile(
    path,
    buildManagedPeFixture({ corruptMetadataSignature: true }),
  );
  const { client, close } = await createApplicationMcpHarness();
  onTestFinished(close);
  const reply = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path },
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const parent = parseEvidence(reply.structuredContent);
  const report = managedMemberInspectionSchema.parse(parent.normalized_result);
  expect(report.metadata.status).toBe("malformed");
  const {
    exported_types: _exported,
    user_strings: _strings,
    ...oldReport
  } = report;
  const historical = createEvidence(undefined, parent.provider, {
    operation: parent.operation,
    parameters: parent.parameters,
    result: oldReport,
    limitations: parent.limitations,
  });
  for (const collection of ["exported_types", "user_strings"] as const) {
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: historical },
      view: { kind: "managed-members", collection },
    });
    if (!result.ok) throw result.error;
    const page = analysisViewResultSchema.parse(result.value.normalized_result);
    expect(page).toMatchObject({
      item: null,
      source_collection_available: false,
      source_metadata_status: "malformed",
      source_coverage: report.coverage,
    });
    expect(page.unknowns.join(" ")).toContain("no recorded subject");
  }
  const result = inspectAnalysisView({
    source: { kind: "inline", evidence: historical },
    view: { kind: "summary" },
  });
  if (!result.ok) throw result.error;
  const summary = managedMemberSummaryViewResultSchema.parse(
    result.value.normalized_result,
  ).summary;
  expect(summary.reported_counts.exported_types).toBeNull();
  expect(summary.reported_counts.user_strings).toBeNull();
  expect(summary.coverage).toEqual(report.coverage);
  const inconsistent = createEvidence(
    { path, format: "pe", sha256: "b".repeat(64) },
    parent.provider,
    {
      operation: parent.operation,
      parameters: parent.parameters,
      result: parent.normalized_result,
    },
  );
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: inconsistent },
      view: { kind: "summary" },
    }),
  ).toMatchObject({ ok: false, error: { _tag: "EvidenceIntegrityError" } });
}, 30000);

it("keeps partial user-string coverage separate from successfully decoded member bodies", async () => {
  const directory = await createTestTempDirectory(
    "rea-member-string-coverage-",
  );
  const path = join(directory, "partial-strings.dll");
  await writeFile(
    path,
    buildManagedPeFixture({
      ilBody: Buffer.from([0x1a, 0x72, 1, 0, 0, 0x70, 0x2a]),
      userStringHeap: Buffer.from([0, 5, 0x41]),
    }),
  );
  const { client, session, close } = await createApplicationMcpHarness();
  onTestFinished(close);
  const reply = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path, detail: "summary" },
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const summary = managedMemberSummaryViewResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  const parent = session.evidenceById(summary.parent_evidence_id)!;
  const report = managedMemberInspectionSchema.parse(parent.normalized_result);
  expect(report.user_strings?.state).toBe("partial");
  expect(report.coverage.state).toBe("complete");
  expect(summary.summary.method_body_counts).toEqual({
    present: 1,
    partial: 0,
    absent: 0,
    malformed: 0,
  });
  expect(summary.summary.user_strings).toEqual({
    state: "partial",
    issues: report.user_strings!.issues,
  });
  const pageReply = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "managed-members", collection: "user_strings" },
    },
  });
  expect(pageReply.isError).not.toBe(true);
  expect(
    parseEvidence(pageReply.structuredContent).normalized_result,
  ).toMatchObject({
    source_user_strings: summary.summary.user_strings,
    source_coverage: report.coverage,
    source_collection_available: true,
  });
}, 30000);

it("rejects summary before path access without retention, and keeps complete delivery available", async () => {
  const directory = await createTestTempDirectory("rea-member-no-retention-");
  const path = join(directory, "fixture.dll");
  await writeFile(path, buildManagedPeFixture());
  const analysis = createTestBinarySession(() => {
    throw new Error("No deep provider needed");
  });
  const server = createServer({ kind: "fixed", analysis });
  const client = new Client({ name: "member-summary-fixed", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await analysis.close();
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const rejected = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path: join(directory, "absent.dll"), detail: "summary" },
  });
  expect(parseMcpToolError(rejected).error.code).toBe("capability_unavailable");
  const complete = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path },
  });
  expect(complete.isError).not.toBe(true);
  expect(parseEvidence(complete.structuredContent).operation).toBe(
    "inspect_managed_members",
  );
}, 30000);

it("keeps complete member Evidence when delivery exceeds capacity and serves a smaller page", async () => {
  const directory = await createTestTempDirectory("rea-member-capacity-");
  const path = join(directory, "many-methods.dll");
  await writeFile(path, buildManagedPeFixture({ methodRowCount: 64 }));
  const { client, session, close } = await createApplicationMcpHarness({
    serverOptions: { delivery: new ToolResultDelivery(32 * 1024) },
  });
  onTestFinished(close);
  const complete = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path },
  });
  expect(parseMcpToolError(complete).error.code).toBe("resource_constraint");
  const summaryReply = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path, detail: "summary" },
  });
  expect(summaryReply.isError, JSON.stringify(summaryReply)).not.toBe(true);
  const summary = managedMemberSummaryViewResultSchema.parse(
    parseEvidence(summaryReply.structuredContent).normalized_result,
  );
  const parent = session.evidenceById(summary.parent_evidence_id)!;
  const report = managedMemberInspectionSchema.parse(parent.normalized_result);
  expect(report.methods).toHaveLength(64);
  const source = { kind: "retained-evidence", evidence_id: parent.evidence_id };
  const oversized = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "managed-members", collection: "methods", limit: 64 },
    },
  });
  expect(parseMcpToolError(oversized).error.code).toBe("resource_constraint");
  const small = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "managed-members", collection: "methods", limit: 1 },
    },
  });
  expect(small.isError).not.toBe(true);
  expect(
    parseEvidence(small.structuredContent).normalized_result,
  ).toMatchObject({
    item: report.methods.slice(0, 1),
    coverage: { total: 64, next_offset: 1, exhausted: false },
  });
}, 30000);
