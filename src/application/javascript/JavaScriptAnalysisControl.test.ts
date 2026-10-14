import { setImmediate } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  completeJavaScriptAnalysisSteps,
  javaScriptAnalysisHeapNeedsCollection,
} from "./JavaScriptAnalysisControl.js";

describe("JavaScript cooperative computation lifecycle", () => {
  it("observes scheduler cancellation and closes abandoned work", async () => {
    const controller = new AbortController();
    let released = false;
    function* work(): Generator<void, number> {
      try {
        for (;;) yield;
      } finally {
        released = true;
      }
    }
    const cancellation = setImmediate().then(() => controller.abort());
    await expect(
      completeJavaScriptAnalysisSteps(work(), controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    await cancellation;
    expect(released).toBe(true);
  });

  it("does not start pre-cancelled work and preserves completed values", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    function* work(): Generator<void, number> {
      started = true;
      yield;
      return 42;
    }
    await expect(
      completeJavaScriptAnalysisSteps(work(), controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(started).toBe(false);
    expect(await completeJavaScriptAnalysisSteps(work())).toBe(42);
  });

  it("collects only after retained heap passes 70% of the old-space limit", () => {
    expect(javaScriptAnalysisHeapNeedsCollection(699, 1000)).toBe(false);
    expect(javaScriptAnalysisHeapNeedsCollection(700, 1000)).toBe(false);
    expect(javaScriptAnalysisHeapNeedsCollection(701, 1000)).toBe(true);
    expect(javaScriptAnalysisHeapNeedsCollection(900, 0)).toBe(false);
    expect(javaScriptAnalysisHeapNeedsCollection(1.5, 1000)).toBe(false);
  });

  it("collects once per climb and again after the heap falls back under the limit", async () => {
    const limit = getHeapStatistics().heap_size_limit;
    const originalUsage = process.memoryUsage;
    const originalCollect = (globalThis as { gc?: () => void }).gc;
    const heapUsed = [limit, limit, Math.floor(limit / 2), limit];
    let collections = 0;
    (globalThis as { gc?: () => void }).gc = () => {
      collections += 1;
    };
    // Node's memoryUsage type is a callable carrying rss()/heapUsed()/total()
    // as function properties; preserve them on the stub.
    process.memoryUsage = Object.assign(
      () =>
        ({
          ...originalUsage(),
          heapUsed: heapUsed.shift() ?? Math.floor(limit / 2),
        }) as ReturnType<typeof process.memoryUsage>,
      originalUsage,
    );
    function* work(): Generator<void, number> {
      yield;
      yield;
      yield;
      yield;
      return collections;
    }
    try {
      expect(await completeJavaScriptAnalysisSteps(work())).toBe(2);
    } finally {
      process.memoryUsage = originalUsage;
      if (originalCollect === undefined)
        delete (globalThis as { gc?: () => void }).gc;
      else (globalThis as { gc?: () => void }).gc = originalCollect;
    }
  });
});
