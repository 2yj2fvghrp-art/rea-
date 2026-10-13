/** Result of an abort-aware interval wait. */
export type AbortableWaitResult = "elapsed" | "aborted";

/** Wait for an interval while removing the supplied abort listener on settle. */
export const waitForAbortableDelay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<AbortableWaitResult> => {
  if (signal?.aborted === true) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const settle = (result: AbortableWaitResult): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => settle("aborted");
    const timer = setTimeout(
      () => settle("elapsed"),
      Math.max(0, milliseconds),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * One absolute deadline shared by every phase of a provider startup handshake.
 *
 * The deadline owns its timer and the listener attached to an optional caller
 * signal. Adapters must dispose it after startup succeeds or fails.
 */
export class ProviderStartupDeadline {
  readonly #controller = new AbortController();
  readonly #deadlineAt: number;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  #timer: NodeJS.Timeout | undefined;
  #interruption: "cancelled" | "timeout" | undefined;

  constructor(
    readonly timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Provider startup timeout must be positive");
    this.#deadlineAt = performance.now() + timeoutMs;
    this.#externalSignal = signal;
    this.#onExternalAbort = () => {
      if (this.#controller.signal.aborted) return;
      if (performance.now() >= this.#deadlineAt) {
        this.#interruption = "timeout";
        this.#abort(
          new DOMException("Provider startup deadline elapsed", "TimeoutError"),
        );
        return;
      }
      this.#interruption = "cancelled";
      this.#abort(signal?.reason);
    };
    if (signal?.aborted === true) {
      this.#onExternalAbort();
      return;
    }
    signal?.addEventListener("abort", this.#onExternalAbort, { once: true });
    this.#armDeadlineTimer(timeoutMs);
  }

  /** Composite signal aborted by either the caller or the absolute deadline. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** First control path that interrupted startup, if any. */
  get interruption(): "cancelled" | "timeout" | undefined {
    return (
      this.#interruption ??
      (performance.now() >= this.#deadlineAt ? "timeout" : undefined)
    );
  }

  /** Milliseconds still available to the next startup phase. */
  remainingMs(): number {
    return Math.max(0, Math.ceil(this.#deadlineAt - performance.now()));
  }

  /** Wait for at most one polling interval under the shared deadline signal. */
  wait(milliseconds: number): Promise<AbortableWaitResult> {
    const budget = this.remainingMs();
    return waitForAbortableDelay(
      Math.min(milliseconds, budget),
      this.signal,
    ).then((result) => {
      // A wait clamped to the full budget can resolve at the deadline before
      // the re-armed abort timer fires. Report the expired deadline as an
      // abort so polling stops at the boundary instead of reporting "elapsed".
      if (result === "elapsed" && performance.now() >= this.#deadlineAt)
        return "aborted";
      return result;
    });
  }

  /** Release the deadline timer and external abort listener. */
  dispose(): void {
    this.#clearTimer();
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
  }

  #abort(reason: unknown): void {
    this.#clearTimer();
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
    this.#controller.abort(reason);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Arm (or re-arm) the timer that expires the absolute monotonic deadline.
   *
   * Node timers can fire a fraction of a millisecond before the deadline.
   * Aborting on such an early delivery would expire a future deadline, so the
   * callback re-checks the monotonic clock: it only classifies "timeout" once
   * the deadline has actually expired, otherwise it re-arms for the residual
   * budget. The residual budget strictly decreases, so the re-arm converges.
   */
  #armDeadlineTimer(milliseconds: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#controller.signal.aborted) return;
      if (performance.now() >= this.#deadlineAt) {
        this.#interruption = "timeout";
        this.#abort(
          new DOMException("Provider startup deadline elapsed", "TimeoutError"),
        );
        return;
      }
      this.#armDeadlineTimer(this.remainingMs());
    }, milliseconds);
  }
}
