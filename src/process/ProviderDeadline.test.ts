import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderStartupDeadline } from "./ProviderDeadline.js";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([-3_600_000, 3_600_000])(
  "keeps the elapsed budget when the wall clock jumps by %i ms",
  async (jump) => {
    const deadline = new ProviderStartupDeadline(1000);
    try {
      await vi.advanceTimersByTimeAsync(250);
      vi.setSystemTime(Date.now() + jump);
      expect(deadline.remainingMs()).toBe(750);
      expect(deadline.interruption).toBeUndefined();
      expect(deadline.signal.aborted).toBe(false);
      const waiting = deadline.wait(2000);
      await vi.advanceTimersByTimeAsync(749);
      expect(deadline.interruption).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBe("aborted");
      expect(deadline.interruption).toBe("timeout");
      expect(deadline.remainingMs()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      deadline.dispose();
    }
  },
);

it("preserves caller cancellation after a forward wall-clock correction", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  const deadline = new ProviderStartupDeadline(1000, controller.signal);
  try {
    const waiting = deadline.wait(1000);
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() + 3_600_000);
    controller.abort(reason);
    await expect(waiting).resolves.toBe("aborted");
    expect(deadline.interruption).toBe("cancelled");
    expect(deadline.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    deadline.dispose();
  }
});

it("does not revive an expired budget after the wall clock moves backward", async () => {
  const deadline = new ProviderStartupDeadline(1000);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.interruption).toBe("timeout");
    await expect(deadline.wait(1000)).resolves.toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    deadline.dispose();
  }
});

it("classifies elapsed time before a delayed timer callback and a later abort", () => {
  const controller = new AbortController();
  const deadline = new ProviderStartupDeadline(1000, controller.signal);
  try {
    // Model an event-loop stall: elapsed time advanced, but timers have not run.
    vi.spyOn(performance, "now").mockReturnValue(1001);
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
    controller.abort();
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    deadline.dispose();
  }
});

it("keeps remaining milliseconds integral for downstream request budgets", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(10.25);
  const deadline = new ProviderStartupDeadline(1000);
  try {
    now.mockReturnValue(260.5);
    expect(deadline.remainingMs()).toBe(750);
    now.mockReturnValue(1010.2);
    expect(deadline.remainingMs()).toBe(1);
    expect(deadline.interruption).toBeUndefined();
    now.mockReturnValue(1010.25);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.interruption).toBe("timeout");
  } finally {
    deadline.dispose();
  }
});

it("keeps remaining time and cancellation classification stable across wall-clock jumps", () => {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(10_000, caller.signal);
  try {
    dateNow.mockReturnValue(9_000_000_000_000);
    const remaining = deadline.remainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10_000);
    expect(Number.isInteger(remaining)).toBe(true);
    expect(deadline.interruption).toBeUndefined();
    caller.abort(new Error("caller stopped startup"));
    expect(deadline.interruption).toBe("cancelled");
  } finally {
    deadline.dispose();
  }
});

it("aborts a bounded wait when its real monotonic deadline expires", async () => {
  vi.useRealTimers();
  const deadline = new ProviderStartupDeadline(40);
  try {
    await expect(deadline.wait(500)).resolves.toBe("aborted");
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
  }
});
