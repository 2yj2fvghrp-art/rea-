import { rm } from "node:fs/promises";
import { decodeIdaToolResult } from "../../src/ida/IdaMcpConnection.js";
import { IdaSessionClient } from "../../src/ida/IdaSessionClient.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { createIdaTarget, RecordingIdaMcp } from "./idaMcp.js";

const roots: string[] = [];

/** Remove the workspaces of every session opened through `callGraphSession`. */
export const removeCallGraphSessions = async (): Promise<void> => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
};

export const FUNCTIONS: Readonly<
  Record<string, { addr: string; name: string }>
> = {
  main: { addr: "0x1000", name: "main" },
  "0x1000": { addr: "0x1000", name: "main" },
  "0x2000": { addr: "0x2000", name: "square" },
  "0x3000": { addr: "0x3000", name: "printf_stub" },
};

export const edge = (from: string, to: string) => ({ from, to, type: "call" });
export const graphRow = (
  edges: readonly ReturnType<typeof edge>[],
  extra: Readonly<Record<string, JsonValue>> = {},
): JsonValue => [
  {
    root: "0x1000",
    nodes: [
      { addr: "0x1000", name: "main", depth: 0 },
      { addr: "0x2000", name: "square", depth: 1 },
      { addr: "0x3000", name: "printf_stub", depth: 1 },
    ],
    edges: [...edges],
    max_depth: 1,
    truncated: false,
    limit_reason: null,
    max_edges_per_func: 200,
    per_func_capped: false,
    ...extra,
  },
];

export interface Upstream {
  /** Items the fake `callees` tool reports for the procedure. */
  readonly callees: readonly JsonValue[];
  /** Raw `callgraph` reply, or undefined when the tool is absent/failing. */
  readonly callgraph?: JsonValue;
  readonly callgraphFailure?: string;
}

export const callGraphSession = async (
  upstream: Upstream,
  architecture: "x86_64" | "arm64" = "arm64",
  available: readonly ("x86_64" | "arm64")[] = [architecture],
) => {
  const { root, target } = await createIdaTarget(architecture, available);
  roots.push(root);
  const producer = new RecordingIdaMcp(target, "headless");
  producer.beforeCall = async (name) => {
    if (name === "callgraph" && upstream.callgraphFailure !== undefined)
      decodeIdaToolResult({
        content: [{ type: "text", text: upstream.callgraphFailure }],
        isError: true,
      });
  };
  producer.overrideCall = (name, args): JsonValue | undefined => {
    if (name === "lookup_funcs") {
      const queries = args.queries;
      const query = Array.isArray(queries) ? String(queries[0]) : "";
      const fn = FUNCTIONS[query];
      return [
        fn === undefined
          ? { query, fn: null, error: "Not found" }
          : { query, fn: { ...fn, size: "0x20" }, error: null },
      ];
    }
    if (name === "callees")
      return [{ callees: [...upstream.callees], more: false }];
    if (name === "callgraph") return upstream.callgraph;
    return undefined;
  };
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode: "headless",
      timeoutMs: 1000,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { client, producer };
};
