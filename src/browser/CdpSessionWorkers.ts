import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { CdpEvent } from "./CdpConnection.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { exclusionReasonForUrl } from "./CdpCaptureEventHelpers.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import type { CdpSessionNetwork, SessionTarget } from "./CdpSessionNetwork.js";

type WorkerType = Exclude<SessionTarget["type"], "page">;
type Attribution = SessionTarget["attribution"];

const isWorkerType = (value: unknown): value is WorkerType =>
  value === "worker" || value === "shared_worker" || value === "service_worker";

/** A worker command waits no longer than a body read. */
const WORKER_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Rejections that leave one worker unobserved instead of failing the
 * observation: its session no longer exists, a Target command the browser
 * does not implement, or an attach to a target that no longer exists. Chrome
 * uses -32602 for that only on Target.attachToTarget; elsewhere it means REA
 * sent parameters the browser rejected.
 */
const isWorkerOmission = (method: string, code: number | null): boolean =>
  code === -32_001 ||
  (method.startsWith("Target.") && code === -32_601) ||
  (method === "Target.attachToTarget" && code === -32_602);

/** A worker command's result, or why it could not run on this worker. */
type WorkerReply = { readonly value: unknown } | { readonly omitted: string };

/**
 * Observe in-scope worker traffic. Dedicated workers of the selected page and
 * of observed workers are auto-attached and held at startup only until REA
 * enables their Network domain and worker auto-attach, each step bounded by
 * 5 s, then resumed; their code is never evaluated.
 * Same-context shared and service workers are discovered and attached while
 * running, so their earliest requests can precede observation. Worker
 * coverage is optional: a missing Target command leaves `workers`
 * unavailable, and a worker that ends is a per-worker omission. The page's
 * own out-of-process iframes, which its auto-attach announces, are resumed
 * without observation; each is named, and their requests and WebSockets are
 * excluded as out of target scope.
 */
export class CdpSessionWorkers {
  readonly #attached = new Set<string>();
  readonly #excluded = new Set<string>();
  readonly #unobservedFrames = new Set<string>();
  /** Parent sessions that announce auto-attached workers, with attribution. */
  readonly #parents = new Map<string | undefined, Attribution>();
  /** Ends when a worker session detaches or a discovered target is destroyed. */
  readonly #ends = new Map<string, AbortController>();
  #browserContextId: string | undefined;

  constructor(
    private readonly network: CdpSessionNetwork,
    private readonly page: SessionTarget,
  ) {
    this.#attached.add(page.target_id);
    this.#parents.set(page.sessionId, "page");
  }

  async attach(): Promise<void> {
    const { completeness, limitations } = this.network.context;
    const autoAttach = await this.#optional(
      this.page.sessionId,
      "Target.setAutoAttach",
      AUTO_ATTACH,
    );
    if (autoAttach === undefined) completeness.unavailable("workers");
    if (this.page.sessionId === undefined) {
      completeness.attachLimited("workers");
      limitations.push(
        "Shared and service workers need a browser-level CDP transport; this page-scoped transport cannot attach them.",
      );
      return;
    }
    const info = await this.#optional(undefined, "Target.getTargetInfo", {
      targetId: this.page.target_id,
    });
    if (info === undefined) return completeness.unavailable("workers");
    const browserContextId = cdpStringValue(
      recordValue(recordValue(info)?.targetInfo)?.browserContextId,
    );
    if (browserContextId === undefined) {
      completeness.exclude("workers", "invalid_protocol_value", null);
      limitations.push(
        "Shared and service workers were not observed: the browser did not report the page's browser context.",
      );
      return;
    }
    this.#browserContextId = browserContextId;
    const discovery = await this.#optional(
      undefined,
      "Target.setDiscoverTargets",
      { discover: true },
    );
    if (discovery === undefined) completeness.unavailable("workers");
  }

  ingest(event: CdpEvent): void {
    const params = recordValue(event.params);
    const info = recordValue(params?.targetInfo);
    const targetId = cdpStringValue(info?.targetId);
    if (event.method === "Target.detachedFromTarget")
      return this.#ended(cdpStringValue(params?.sessionId));
    if (event.method === "Target.targetDestroyed")
      return this.#ended(cdpStringValue(params?.targetId));
    const parent = this.#parents.get(event.sessionId);
    if (event.method === "Target.attachedToTarget" && parent !== undefined)
      return this.#announced(params, info, targetId, parent);
    if (
      info === undefined ||
      targetId === undefined ||
      this.network.stopped ||
      event.sessionId !== undefined ||
      this.#browserContextId === undefined ||
      (event.method !== "Target.targetCreated" &&
        event.method !== "Target.targetInfoChanged")
    )
      return;
    if (
      (info.type === "shared_worker" || info.type === "service_worker") &&
      !this.#attached.has(targetId)
    )
      this.#discovered(info, targetId);
  }

  /**
   * REA does not observe the page's out-of-process iframes; their traffic is
   * missing.
   */
  #unobservedFrame(targetId: string): void {
    if (this.#unobservedFrames.has(targetId)) return;
    this.#unobservedFrames.add(targetId);
    const { completeness, limitations } = this.network.context;
    // REA cannot count what it does not observe.
    completeness.exclude("network_requests", "out_of_target_scope", null);
    completeness.exclude("websocket_connections", "out_of_target_scope", null);
    limitations.push(
      `Out-of-process iframe ${targetId} of the selected page was not observed; its requests and WebSocket connections, and those of frames inside it, are not recorded.`,
    );
  }

  #announced(
    params: UnknownRecord | undefined,
    info: UnknownRecord | undefined,
    targetId: string | undefined,
    attribution: Attribution,
  ): void {
    const sessionId = cdpStringValue(params?.sessionId);
    if (sessionId === undefined) {
      // Without a session REA can neither observe nor resume the worker.
      this.#exclude(
        targetId ?? "unaddressable-worker",
        "invalid_protocol_value",
      );
      this.network.context.limitations.push(
        "A worker was announced without a session and could not be observed or resumed.",
      );
      return;
    }
    this.network.track(
      this.#autoAttached(
        info,
        sessionId,
        params?.waitingForDebugger === true,
        attribution,
      ),
    );
  }

  /**
   * Enable observation of an in-scope worker or flag an out-of-process iframe,
   * then always release a held start.
   */
  async #autoAttached(
    info: UnknownRecord | undefined,
    sessionId: string,
    waiting: boolean,
    attribution: Attribution,
  ): Promise<void> {
    const targetId = cdpStringValue(info?.targetId);
    const frame = info?.type === "iframe";
    try {
      if (info === undefined || targetId === undefined)
        this.#exclude(sessionId, "invalid_protocol_value");
      else if (frame && !this.network.stopped) this.#unobservedFrame(targetId);
      else if (info.type === "worker" && !this.network.stopped)
        await this.#observe(info, sessionId, attribution);
    } finally {
      if (waiting) {
        const resumed = await this.#command(
          sessionId,
          "Runtime.runIfWaitingForDebugger",
          {},
        );
        if ("omitted" in resumed) {
          // A worker left paused made none of its traffic, unless it ended;
          // an iframe's traffic is never recorded.
          if (!frame && !this.#endSignal(sessionId).signal.aborted)
            this.network.context.completeness.unavailable("workers");
          this.network.context.limitations.push(
            `A held ${frame ? "iframe" : "worker"} was not resumed: ${resumed.omitted}`,
          );
        }
      }
    }
  }

  #discovered(info: UnknownRecord, targetId: string): void {
    const { allowedOrigins } = this.network.context;
    if (info.browserContextId !== this.#browserContextId)
      return this.#exclude(targetId, "out_of_target_scope");
    const url = cdpStringValue(info.url);
    // A starting worker reports its script URL in a later targetInfoChanged.
    if (url === undefined || url === "") return;
    if (allowedSanitizedUrl(url, allowedOrigins) === undefined)
      return this.#exclude(targetId, exclusionReasonForUrl(url));
    this.#attached.add(targetId);
    this.network.track(this.#attachDiscovered(info, targetId));
  }

  async #attachDiscovered(
    info: UnknownRecord,
    targetId: string,
  ): Promise<void> {
    const attached = await this.#command(
      undefined,
      "Target.attachToTarget",
      { targetId, flatten: true },
      targetId,
    );
    if ("omitted" in attached)
      return this.#workerOmitted(
        `Worker ${targetId} was not observed: ${attached.omitted}`,
      );
    const sessionId = cdpStringValue(recordValue(attached.value)?.sessionId);
    if (sessionId === undefined)
      throw new BrowserObservationError(
        "observe_web_session",
        "protocol_error",
      );
    await this.#observe(info, sessionId, "origin");
  }

  async #observe(
    info: UnknownRecord,
    sessionId: string,
    attribution: Attribution,
  ): Promise<void> {
    const { allowedOrigins } = this.network.context;
    const url = allowedSanitizedUrl(info.url, allowedOrigins);
    const targetId = cdpStringValue(info.targetId) ?? sessionId;
    const type = info.type;
    if (url === undefined || !isWorkerType(type))
      return this.#exclude(
        targetId,
        exclusionReasonForUrl(cdpStringValue(info.url)),
      );
    this.#attached.add(targetId);
    this.network.register({
      target_id: targetId,
      type,
      url: url.url,
      attribution,
      sessionId,
    });
    const enabled = await this.#command(
      sessionId,
      "Network.enable",
      this.network.enableParameters,
    );
    if ("omitted" in enabled)
      return this.#workerOmitted(
        `Network observation could not start for worker ${targetId}: ${enabled.omitted}`,
      );
    // A worker can start its own dedicated workers; they share its attribution.
    this.#parents.set(sessionId, attribution);
    const nested = await this.#command(
      sessionId,
      "Target.setAutoAttach",
      AUTO_ATTACH,
    );
    if ("omitted" in nested)
      this.#workerOmitted(
        `Workers started by worker ${targetId} were not observed: ${nested.omitted}`,
      );
  }

  /**
   * Send one command for a worker within a deadline, ending early when the
   * worker does. Caller cancellation and unexpected failures are rethrown.
   */
  async #command(
    sessionId: string | undefined,
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    endKey: string | undefined = sessionId,
  ): Promise<WorkerReply> {
    const { connection, signal } = this.network.context;
    const deadline = AbortSignal.timeout(WORKER_COMMAND_TIMEOUT_MS);
    const ended =
      endKey === undefined ? undefined : this.#endSignal(endKey).signal;
    try {
      return {
        value: await connection.send(
          method,
          parameters,
          sessionId,
          AbortSignal.any([
            deadline,
            this.network.terminated,
            ...(ended === undefined ? [] : [ended]),
            ...(signal === undefined ? [] : [signal]),
          ]),
        ),
      };
    } catch (cause: unknown) {
      if (signal?.aborted === true) throw cause;
      // A disconnect rejects pending sends; it ends the target, as for reads.
      if (this.network.terminated.aborted)
        return { omitted: "the target ended." };
      if (ended?.aborted === true) return { omitted: "the worker ended." };
      if (deadline.aborted)
        return {
          omitted: `${method} did not answer within ${String(WORKER_COMMAND_TIMEOUT_MS / 1000)} s.`,
        };
      if (
        cause instanceof CdpCommandRejection &&
        isWorkerOmission(method, cause.code)
      )
        return { omitted: cause.userMessage ?? cause.message };
      throw cause;
    }
  }

  #workerOmitted(limitation: string): void {
    this.network.context.completeness.unavailable("workers");
    this.network.context.limitations.push(limitation);
  }

  #endSignal(key: string): AbortController {
    let controller = this.#ends.get(key);
    if (controller === undefined) {
      controller = new AbortController();
      this.#ends.set(key, controller);
    }
    return controller;
  }

  /** A worker session detached or its target was destroyed. */
  #ended(key: string | undefined): void {
    if (key === undefined || key === this.page.sessionId) return;
    this.#endSignal(key).abort();
    this.network.endSession(key);
  }

  /** Send an optional Target command; undefined when the browser lacks it. */
  async #optional(
    sessionId: string | undefined,
    method: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const { connection, signal, limitations } = this.network.context;
    return await optionalCdpCommand(
      {
        connection,
        sessionId,
        ...(signal === undefined ? {} : { signal }),
      },
      method,
      parameters,
      limitations,
    );
  }

  /** Count each excluded worker target once, however often CDP reports it. */
  #exclude(targetId: string, reason: BrowserExclusionReason): void {
    if (this.#excluded.has(targetId)) return;
    this.#excluded.add(targetId);
    this.network.context.completeness.exclude("workers", reason);
  }
}

/** Dedicated workers, and the page's out-of-process iframes; a worker has none. */
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "worker" }, { type: "iframe" }],
};
