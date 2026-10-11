import { z } from "zod";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  webNetworkCaptureSchema,
} from "../webNetworkCapture.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";

export const apiSurfaceViewSchema = z.strictObject({
  kind: z.literal("api-surface"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(50),
});
const ruleSchema = z.enum(["numeric", "uuid", "hex", "iso-date"]);
const groupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.number().int().nonnegative(),
      rule: ruleSchema,
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  record_ordinals: z.array(z.number().int().nonnegative()),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  flags: z.array(
    z.enum(["single-sample", "mixed-statuses", "mixed-content-types"]),
  ),
});
export const apiSurfaceFields = {
  records: z.strictObject({
    examined: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  templated_groups: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Groups across every page that carry at least one templated segment.",
    ),
  groups: z.array(groupSchema),
  excluded_records: z.array(
    z.strictObject({
      ordinal: z.number().int().nonnegative(),
      reason: z.enum([
        "url-redacted",
        "url-unparseable",
        "request-unavailable",
        "method-unavailable",
      ]),
    }),
  ),
};
type Group = z.output<typeof groupSchema>;
type Surface = Extract<UnsignedAnalysisView, { kind: "api-surface" }>;
type GroupBuckets = Map<string, Map<string, Map<string, Map<string, Group>>>>;
const requestSchema = z.object({
  request: z.object({ url: z.unknown(), method: z.unknown() }),
});
const contentSchema = z.object({ mimeType: z.unknown().optional() });
const responseSchema = z.object({
  response: z.object({
    status: z.unknown().optional(),
    content: z.unknown().optional(),
  }),
});

// Upper bound of serialized bytes one templated segment adds to a group.
const TEMPLATED_SEGMENT_BYTES = 128;

// Upper bound of transient memory per split segment: the split string, the
// mapped template part, a segment descriptor and its deduplication entry.
const SPLIT_SEGMENT_BYTES = 1024;

// Upper bound of one retained deduplication set and its first entry. These
// sets outlive the per-path split, so every group is charged before allocation.
const DEDUP_SET_BYTES = 1024;

// Template, map key, and canonical serialization each copy a retained path.
const RETAINED_PATH_COPIES = 4;

// Group key and canonical output each retain method and origin text.
const IDENTITY_TEXT_COPIES = 2;

// type/subtype token after parameter stripping, per RFC 9110.
const MEDIA_TYPE_ESSENCE =
  /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/u;

// Serialized bytes one retained observed value adds beyond its own text.
const OBSERVED_VALUE_BYTES = 16;

/**
 * Recorded path of a canonical `scheme://authority/path` URL, before WHATWG
 * dot-segment removal; null for spellings whose path cannot be read verbatim.
 */
const recordedPath = (url: string): string | null => {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(url);
  if (scheme === null) return null;
  const rest = url.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?#]/u);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  // An empty, backslashed, or control-character authority lets WHATWG move text
  // between authority and path. Tab and newline are removed before URL parsing.
  if (
    authority.length === 0 ||
    authority.includes("\\") ||
    authority.includes("\t") ||
    authority.includes("\n") ||
    authority.includes("\r")
  )
    return null;
  if (authorityEnd < 0 || rest[authorityEnd] !== "/") return "/";
  const path = rest.slice(authorityEnd);
  const end = path.search(/[?#]/u);
  return end < 0 ? path : path.slice(0, end);
};

const slashCount = (path: string): number => {
  let count = 0;
  for (let index = 0; index < path.length; index += 1)
    if (path.charCodeAt(index) === 0x2f) count += 1;
  return count;
};

const segmentRule = (value: string): z.output<typeof ruleSchema> | null => {
  if (/^[0-9]+$/.test(value)) return "numeric";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return "uuid";
  if (/^[0-9a-f]{32,}$/i.test(value)) return "hex";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
      return "iso-date";
  }
  return null;
};

/** Group retained HAR request lines; format matches do not establish handler identity. */
export const projectWebNetworkApiSurfaceView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  const unsupported = (reason: string) =>
    err(
      new AnalysisUnsupportedTargetError(
        "inspect_analysis_view",
        parent.evidenceId,
        reason,
      ),
    );
  if (
    parent.operation !== "inspect_web_network_capture" ||
    view.kind !== "api-surface"
  )
    return unsupported(
      `View ${view.kind} is unsupported for parent operation ${parent.operation}; api-surface requires inspect_web_network_capture.`,
    );
  const parsed = webNetworkCaptureSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisViewInputError([
        {
          path: ["source"],
          reason: "invalid_value",
          message:
            "Parent Evidence result does not match inspect_web_network_capture.",
        },
      ]),
    );
  const capture = parsed.data;
  if (capture.format !== "har")
    return unsupported(
      `api-surface does not support capture format ${capture.format}.`,
    );
  const declarations = z
    .object({ sensitive_value_count: z.number().int().nonnegative() })
    .safeParse(parent.parameters);
  if (!declarations.success || declarations.data.sensitive_value_count > 0)
    return unsupported("sensitive_values_unretained");
  const buckets: GroupBuckets = new Map();
  const excluded: Surface["excluded_records"] = [];
  let unavailableResponse = false;
  let projectedBytes = 0;
  const budget = WEB_NETWORK_CAPTURE_LIMITS.outputBytes;
  const retained = new Map<Group, Set<string>[]>();
  const contentTypes = new Map<Group, Set<string>>();
  const overBudget = (reason: string) =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "memory",
        reason,
        { output_bytes: budget },
      ),
    );
  for (const record of capture.records) {
    const request = requestSchema.safeParse(record.reported);
    if (!request.success) {
      excluded.push({ ordinal: record.ordinal, reason: "request-unavailable" });
      continue;
    }
    const { url, method } = request.data.request;
    if (url === null) {
      excluded.push({ ordinal: record.ordinal, reason: "url-redacted" });
      continue;
    }
    let parsedUrl: URL;
    try {
      if (typeof url !== "string") throw new TypeError("Unavailable URL");
      parsedUrl = new URL(url);
      if (parsedUrl.origin === "null") throw new TypeError("URL has no origin");
    } catch {
      excluded.push({ ordinal: record.ordinal, reason: "url-unparseable" });
      continue;
    }
    if (typeof method !== "string" || method.length === 0) {
      excluded.push({ ordinal: record.ordinal, reason: "method-unavailable" });
      continue;
    }
    const path = recordedPath(url);
    if (path === null) {
      excluded.push({ ordinal: record.ordinal, reason: "url-unparseable" });
      continue;
    }
    // Transient split copies coexist with bytes already retained for other groups.
    if (projectedBytes + slashCount(path) * SPLIT_SEGMENT_BYTES > budget)
      return overBudget(
        "One recorded path has more segments than the reply budget allows.",
      );
    // Four retained copies of this path coexist with bytes already retained.
    if (projectedBytes + path.length * RETAINED_PATH_COPIES > budget)
      return overBudget(
        "Retained path text would exceed the capture reply budget.",
      );
    const segments: Group["templated_segments"] = [];
    const template = path
      .split("/")
      .map((value, index) => {
        const rule = segmentRule(value);
        if (rule === null) return value;
        segments.push({
          segment_index: index - 1,
          rule,
          basis: "inferred",
          observed_values: [value],
        });
        return `{${rule}}`;
      })
      .join("/");
    // Both retained identity copies coexist with bytes already retained.
    const identityBytes = method.length + parsedUrl.origin.length;
    if (projectedBytes + identityBytes * IDENTITY_TEXT_COPIES > budget)
      return overBudget(
        "Retained request method or origin would exceed the capture reply budget.",
      );
    // Rule positions keep a recorded literal "{numeric}" apart from a templated one.
    const rules = JSON.stringify(
      segments.map((segment) => [segment.segment_index, segment.rule]),
    );
    const origin = parsedUrl.origin;
    const segmentBytes = segments.reduce(
      (sum, segment) =>
        sum + TEMPLATED_SEGMENT_BYTES + segment.observed_values[0]!.length,
      0,
    );
    const groupBytes =
      path.length * RETAINED_PATH_COPIES +
      identityBytes * IDENTITY_TEXT_COPIES +
      segmentBytes;
    let group = buckets.get(method)?.get(origin)?.get(template)?.get(rules);
    if (group === undefined) {
      // Path, identity, and segment charges are retained together.
      if (projectedBytes + groupBytes > budget)
        return overBudget(
          "Retained group text would exceed the capture reply budget.",
        );
      projectedBytes += groupBytes;
      group = {
        method,
        origin,
        path_template: template,
        templated_segments: segments,
        record_ordinals: [],
        statuses: [],
        content_types: [],
        flags: [],
      };
      const byOrigin = buckets.get(method) ?? new Map();
      buckets.set(method, byOrigin);
      const byTemplate = byOrigin.get(origin) ?? new Map();
      byOrigin.set(origin, byTemplate);
      const byRule = byTemplate.get(template) ?? new Map();
      byTemplate.set(template, byRule);
      byRule.set(rules, group);
      contentTypes.set(group, new Set());
    } else {
      // Equal templates have the same ordered rule positions; keep new values only.
      // Deduplication sets are created on the first merge, not for every group.
      const existing = group.templated_segments;
      let seen = retained.get(group);
      if (seen === undefined) {
        const dedupBytes = existing.length * DEDUP_SET_BYTES;
        if (projectedBytes + dedupBytes > budget)
          return overBudget(
            "Retained templated-segment deduplication would exceed the capture reply budget.",
          );
        projectedBytes += dedupBytes;
        seen = existing.map((segment) => new Set(segment.observed_values));
        retained.set(group, seen);
      }
      segments.forEach((segment, index) => {
        const value = segment.observed_values[0]!;
        const values = seen[index];
        if (values === undefined || values.has(value)) return;
        values.add(value);
        group?.templated_segments[index]?.observed_values.push(value);
        projectedBytes += OBSERVED_VALUE_BYTES + value.length;
      });
    }
    if (projectedBytes > budget)
      return overBudget(
        "Retained templated segments would exceed the capture reply budget.",
      );
    group.record_ordinals.push(record.ordinal);
    const response = responseSchema.safeParse(record.reported);
    const status = response.success ? response.data.response.status : undefined;
    const content = contentSchema.safeParse(
      response.success ? response.data.response.content : undefined,
    );
    const mime = content.success ? content.data.mimeType : undefined;
    // HAR uses status 0 and an empty mimeType for an unavailable response.
    if (typeof status === "number" && status !== 0) group.statuses.push(status);
    else unavailableResponse = true;
    // Media type and subtype are case-insensitive; compare their lowercase essence.
    const rawMime = typeof mime === "string" ? mime : "";
    if (rawMime.length > 0 && projectedBytes + rawMime.length > budget)
      return overBudget(
        "Retained content type text would exceed the capture reply budget.",
      );
    const essence = rawMime.split(";", 1).join("").trim().toLowerCase();
    if (MEDIA_TYPE_ESSENCE.test(essence)) {
      const seenTypes = contentTypes.get(group);
      if (seenTypes !== undefined && !seenTypes.has(essence)) {
        projectedBytes += essence.length;
        seenTypes.add(essence);
        group.content_types.push(essence);
      }
    } else unavailableResponse = true;
  }
  const groups: Group[] = [];
  for (const byOrigin of buckets.values())
    for (const byTemplate of byOrigin.values())
      for (const byRule of byTemplate.values()) groups.push(...byRule.values());
  groups.sort(
    (a, b) =>
      compare(a.origin, b.origin) ||
      compare(a.path_template, b.path_template) ||
      compare(a.method, b.method),
  );
  for (const group of groups) {
    group.statuses = [...new Set(group.statuses)].sort((a, b) => a - b);
    group.content_types = uniqueSorted(group.content_types);
    for (const segment of group.templated_segments)
      segment.observed_values = uniqueSorted(segment.observed_values);
    if (group.record_ordinals.length === 1) group.flags.push("single-sample");
    if (group.statuses.length > 1) group.flags.push("mixed-statuses");
    if (group.content_types.length > 1) group.flags.push("mixed-content-types");
  }
  const page = groups.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "api-surface",
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_web_network_capture",
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: capture.artifact.path, sha256: capture.artifact.sha256 },
    coverage: pageViewCoverage(view.offset, page.length, groups.length),
    records: {
      examined: capture.records.length,
      total: capture.total_records,
      excluded: excluded.length,
    },
    templated_groups: groups.filter(
      (group) => group.templated_segments.length > 0,
    ).length,
    groups: page,
    excluded_records: excluded,
    limitations: uniqueSorted([
      ...parent.limitations,
      ...capture.records.flatMap((record) => record.limitations),
      "Grouping does not establish handler identity, URL-space schemas or causality.",
      ...(capture.records.length < capture.total_records
        ? [
            "Parent contains an ordinal subset; the surface covers only retained records.",
          ]
        : []),
    ]),
    unknowns: unavailableResponse
      ? [
          "Some retained records have unavailable status or content type values.",
        ]
      : [],
  });
};
