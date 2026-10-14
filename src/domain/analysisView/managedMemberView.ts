import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { managedMemberInspectionSchema } from "../managed/managedArtifact.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const member = managedMemberInspectionSchema.shape;
const stringCoverageSchema = member.user_strings
  .unwrap()
  .unwrap()
  .omit({ literals: true })
  .nullable();
const count = z.number().int().nonnegative();

/** Page original member rows, including the independently covered #US literals. */
export const managedMemberViewRequestSchema = z.strictObject({
  kind: z.literal("managed-members"),
  collection: z.enum([
    "types",
    "exported_types",
    "fields",
    "methods",
    "member_refs",
    "call_edges",
    "field_accesses",
    "user_strings",
  ]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const managedMemberViewItemSchema = z.union([
  z.array(member.types.element.strict()),
  z.array(member.exported_types.unwrap().unwrap().element.strict()).nullable(),
  z.array(member.fields.element.strict()),
  z.array(member.methods.element.strict()),
  z.array(member.member_refs.element.strict()),
  z.array(member.call_edges.element.strict()),
  z.array(member.field_accesses.element.strict()),
  z
    .array(
      member.user_strings.unwrap().unwrap().shape.literals.element.strict(),
    )
    .nullable(),
]);

/** Keep selection, identity and source coverage without the row inventories. */
export const managedMemberSummarySchema = managedMemberInspectionSchema
  .omit({
    types: true,
    exported_types: true,
    fields: true,
    methods: true,
    member_refs: true,
    call_edges: true,
    field_accesses: true,
    user_strings: true,
  })
  .extend({
    user_strings: stringCoverageSchema,
    method_body_counts: z.strictObject({
      present: count,
      partial: count,
      absent: count,
      malformed: count,
    }),
    reported_counts: z.strictObject({
      types: count,
      exported_types: count.nullable(),
      fields: count,
      methods: count,
      member_refs: count,
      call_edges: count,
      field_accesses: count,
      user_strings: count.nullable(),
    }),
  });

export const managedMemberViewContextSchema = z.strictObject({
  identity_scope: member.identity_scope,
  module: member.module,
  selection: member.selection,
  source_metadata_status: member.metadata.shape.status,
  source_coverage: member.coverage,
  source_user_strings: stringCoverageSchema,
  source_collection_available: z.boolean(),
});

const summarizeManagedMembers = (
  report: ReturnType<typeof managedMemberInspectionSchema.parse>,
  user_strings: z.infer<typeof stringCoverageSchema>,
): z.infer<typeof managedMemberSummarySchema> => {
  const {
    types,
    exported_types,
    fields,
    methods,
    member_refs,
    call_edges,
    field_accesses,
    user_strings: strings,
    ...summary
  } = report;
  const reported_counts = {
    types: types.length,
    exported_types: exported_types?.length ?? null,
    fields: fields.length,
    methods: methods.length,
    member_refs: member_refs.length,
    call_edges: call_edges.length,
    field_accesses: field_accesses.length,
    user_strings: strings?.literals.length ?? null,
  };
  const method_body_counts = {
    present: 0,
    partial: 0,
    absent: 0,
    malformed: 0,
  };
  for (const method of methods) method_body_counts[method.body.status] += 1;
  return { ...summary, user_strings, reported_counts, method_body_counts };
};

/** Pure projection of authenticated, retained member Evidence. */
export const projectManagedMemberView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "managed-members")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Managed member inspection supports summary and managed-members views.",
        },
      ]),
    );
  const parsed = managedMemberInspectionSchema.safeParse(
    parent.normalizedResult,
  );
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  const report = parsed.data;
  const strings = report.user_strings;
  const stringCoverage =
    strings === null ? null : { state: strings.state, issues: strings.issues };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_managed_members" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      "Counts and page exhaustion describe retained rows, not complete source metadata or method bodies. Original member coverage and independent user-string coverage remain authoritative.",
      "MemberRef rows are assembly-wide; declaring-type selection does not filter that inventory. Metadata tokens are build-local and require the recorded artifact SHA-256 and module MVID.",
      "A null collection or count means it was not examined, not that it was empty. This view does not load or execute the assembly.",
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
          ]
        : []),
      ...(report.identity_scope.requires_mvid === null
        ? [
            "The module MVID is unknown; tokens cannot establish a cross-observation module match.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const summary = summarizeManagedMembers(report, stringCoverage);
    const total = Object.values(summary.reported_counts).reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary,
      coverage: completeWithinViewCoverage(total, total),
    });
  }
  const collection =
    view.collection === "user_strings"
      ? (strings?.literals ?? null)
      : report[view.collection];
  const item = collection?.slice(view.offset, view.offset + view.limit) ?? null;
  return ok({
    kind: "managed-members",
    view,
    item,
    ...shared,
    identity_scope: report.identity_scope,
    module: report.module,
    selection: report.selection,
    source_metadata_status: report.metadata.status,
    source_coverage: report.coverage,
    source_user_strings: stringCoverage,
    source_collection_available: collection !== null,
    coverage: pageViewCoverage(
      view.offset,
      item?.length ?? 0,
      collection?.length ?? 0,
    ),
  });
};
