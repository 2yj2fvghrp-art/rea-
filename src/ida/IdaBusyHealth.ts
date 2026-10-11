import { setTimeout as delay } from "node:timers/promises";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import { busyHealthSchema } from "./IdaProtocolValues.js";

/** Pause between health reads while a freshly opened worker reports itself busy. */
const BUSY_HEALTH_RETRY_MS = 100;
/** Only a tool-name-shaped value is repeated; other producer text is not echoed into errors. */
const BUSY_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/u;

const busyToolName = (tool: string | undefined): string =>
  tool !== undefined && BUSY_TOOL_NAME.test(tool) ? tool : "unknown";

/**
 * Reads `server_health` until the worker stops reporting a transient busy
 * state. The wait ends when the worker answers, the caller aborts, or the
 * registration's request deadline has elapsed; any other payload is returned
 * for the caller's strict parse.
 */
export const readSettledHealth = async (
  connection: IdaMcpConnection,
  database: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<JsonValue> => {
  const started = performance.now();
  for (;;) {
    const raw = await connection.call("server_health", { database });
    const busy = busyHealthSchema.safeParse(raw);
    if (!busy.success) return raw;
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0)
      throw new AnalysisTimeoutError(
        `server_health: headless worker still busy in ${busyToolName(busy.data.busy_tool)}`,
        timeoutMs,
        { cause: raw },
      );
    await delay(Math.min(BUSY_HEALTH_RETRY_MS, remaining), undefined, {
      signal,
    });
  }
};
