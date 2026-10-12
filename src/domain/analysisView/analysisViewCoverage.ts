import type { AnalysisViewCoverage } from "./analysisView.js";
/** No selected inference was examined; neither total nor exhaustion is established. */
export const unknownViewCoverage = (): AnalysisViewCoverage => ({
  status: "unknown",
  examined: 0,
  total: null,
  next_offset: null,
  exhausted: null,
});
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
