import { afterEach, expect, it, vi } from "vitest";
import { ProviderStartupDeadline } from "./ProviderDeadline.js";

afterEach(() => {
  vi.restoreAllMocks();
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
  const deadline = new ProviderStartupDeadline(40);
  try {
    await expect(deadline.wait(500)).resolves.toBe("aborted");
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
  }
});

it("does not expire a future monotonic deadline on an early timer callback", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    monotonic = 39;
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.remainingMs()).toBe(1);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.interruption).toBeUndefined();
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("aborts when the re-armed timer reaches the absolute deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    monotonic = 39;
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.signal.aborted).toBe(false);
    monotonic = 40;
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("reports a wait that resolves at the deadline as aborted, not elapsed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(500);
    monotonic = 40;
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toBe("aborted");
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("resolves a polling interval shorter than the budget as elapsed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(10);
    monotonic = 10;
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("elapsed");
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.remainingMs()).toBe(30);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("keeps caller cancellation classified without reporting an exhausted budget", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(40, caller.signal);
  try {
    monotonic = 20;
    caller.abort(new Error("caller stopped startup"));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.interruption).toBe("cancelled");
    expect(deadline.remainingMs()).toBe(20);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("releases the timer and listener on dispose with a pending wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(500);
    deadline.dispose();
    monotonic = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(deadline.signal.aborted).toBe(false);
    // The deadline expired while disposed, so the clamped wait resolves
    // "aborted" from the monotonic clock instead of polling past expiry.
    await expect(pending).resolves.toBe("aborted");
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});
