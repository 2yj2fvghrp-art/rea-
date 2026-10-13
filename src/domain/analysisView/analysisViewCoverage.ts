import { uniqueSorted } from "../canonicalOrdering.js";
import type { AnalysisViewCoverage } from "./analysisView.js";

/** Coverage for a summary, facet, or single selected object. */
export const completeWithinViewCoverage = (
  examined: number,
  total: number,
): AnalysisViewCoverage => ({
  status: "complete-within-view",
  examined,
  total,
  next_offset: null,
  exhausted: true,
});

/** Coverage for a stable page, including an offset past the collection. */
export const pageViewCoverage = (
  offset: number,
  examined: number,
  total: number,
): AnalysisViewCoverage => {
  const exhausted = offset >= total || offset + examined >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : offset + examined,
    exhausted,
  };
};

/** Maximum distinct limitation or unknown messages carried by one view. */
export const ANALYSIS_VIEW_MESSAGE_LIMIT = 64;

/**
 * Deduplicate, sort and bound view messages. A parent can carry tens of
 * thousands of limitations; repeating them in every view would make each page
 * as large as the complete record. Omitted messages stay in the parent.
 */
export const boundedViewMessages = (
  values: readonly string[],
  parentEvidenceId: string,
  field: "limitations" | "unknowns",
): string[] => {
  const unique = uniqueSorted(values);
  if (unique.length <= ANALYSIS_VIEW_MESSAGE_LIMIT) return unique;
  const omitted = unique.length - ANALYSIS_VIEW_MESSAGE_LIMIT;
  return [
    ...unique.slice(0, ANALYSIS_VIEW_MESSAGE_LIMIT),
    `${String(omitted)} additional ${field} omitted from this view; the complete list remains in parent Evidence ${parentEvidenceId} (get_evidence_bundle or export_evidence_bundle).`,
  ];
};
