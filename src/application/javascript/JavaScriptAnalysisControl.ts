import { setImmediate } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

/** Reject cancelled application work before computing or publishing more results. */
export const assertJavaScriptAnalysisActive = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "JavaScript application analysis cancelled",
    );
};

/** Let request control messages run, then recheck the current analysis intent. */
export const checkpointJavaScriptAnalysis = async (
  signal?: AbortSignal,
): Promise<void> => {
  assertJavaScriptAnalysisActive(signal);
  await setImmediate();
  assertJavaScriptAnalysisActive(signal);
};

/**
 * Semantic phases keep less than the temporary graphs they just built. Collect
 * only after a yield, and only once per climb past 70% of the old-space limit,
 * so the owned worker can finish the next phase inside its heap instead of
 * aborting with no retained relations.
 */
export const javaScriptAnalysisHeapNeedsCollection = (
  heapUsed: number,
  heapLimit: number,
): boolean =>
  Number.isSafeInteger(heapUsed) &&
  Number.isSafeInteger(heapLimit) &&
  heapLimit > 0 &&
  heapUsed > Math.floor((heapLimit * 7) / 10);

/** Drive bounded owned-domain steps while permitting cancellation and control I/O. */
export const completeJavaScriptAnalysisSteps = async <Value>(
  steps: Iterator<void, Value, void>,
  signal?: AbortSignal,
): Promise<Value> => {
  let deadline = performance.now() + 8;
  let collectedAboveLimit = false;
  const collect = (globalThis as { gc?: () => void }).gc;
  const heapLimit = getHeapStatistics().heap_size_limit;
  const relieveHeapPressure = (): void => {
    if (collect === undefined) return;
    const heapUsed = process.memoryUsage().heapUsed;
    if (!javaScriptAnalysisHeapNeedsCollection(heapUsed, heapLimit)) {
      collectedAboveLimit = false;
      return;
    }
    if (collectedAboveLimit) return;
    collectedAboveLimit = true;
    collect();
  };
  try {
    for (;;) {
      assertJavaScriptAnalysisActive(signal);
      const step = steps.next();
      if (step.done) {
        assertJavaScriptAnalysisActive(signal);
        return step.value;
      }
      relieveHeapPressure();
      if (performance.now() >= deadline) {
        await checkpointJavaScriptAnalysis(signal);
        deadline = performance.now() + 8;
      }
    }
  } finally {
    steps.return?.();
  }
};
