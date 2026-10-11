import { afterEach, describe, expect, it } from "vitest";
import {
  callGraphSession as session,
  edge,
  graphRow,
  removeCallGraphSessions,
} from "../../tests/fixtures/idaCallGraph.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { IdaSessionClient } from "./IdaSessionClient.js";

afterEach(removeCallGraphSessions);

const EMPTY_CALLEES_LIMITATION =
  "Upstream callees reported no calls for this non-x86 procedure; callee edges come from the upstream call graph, which reports calls to recognized functions only, so other call targets remain unknown.";

const callees = async (client: IdaSessionClient) => {
  const result = await client.execute("procedure_callees", {
    procedure: "main",
  });
  if (!result.ok) throw result.error;
  return result.value;
};

describe("headless IDA callee edges on non-x86 targets", () => {
  it("reads callee edges from the upstream call graph when callees reports none", async () => {
    const { client } = await session({
      callees: [],
      callgraph: graphRow([
        edge("0x1000", "0x2000"),
        edge("0x1000", "0x3000"),
        edge("0x2000", "0x4000"),
      ]),
    });
    try {
      const execution = await callees(client);

      expect(
        execution.result,
        "the two root edges are observed and the child edge is ignored",
      ).toEqual(["0x2000", "0x3000"]);
      expect(
        execution.limitations,
        "an empty callees reply is not proof of absence",
      ).toContain(EMPTY_CALLEES_LIMITATION);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("never reports an unobservable leaf as an observed empty list", async () => {
    const { client } = await session({
      callees: [],
      callgraph: graphRow([]),
    });
    try {
      const execution = await callees(client);

      expect(execution.result, "nothing was observed").toEqual([]);
      expect(
        execution.limitations,
        "the empty result carries the completeness limitation",
      ).toContain(EMPTY_CALLEES_LIMITATION);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("merges a fixed upstream's callees with the graph without duplicates or a warning", async () => {
    const { client } = await session({
      callees: [
        { addr: "0x3000", name: "printf_stub", type: "internal" },
        { addr: "0x2000", name: "square", type: "internal" },
      ],
      callgraph: graphRow([
        edge("0x1000", "0x2000"),
        edge("0x1000", "0x3000"),
        edge("0x1000", "0x2000"),
      ]),
    });
    try {
      const execution = await callees(client);

      expect(
        execution.result,
        "callees order is kept and the duplicate graph edges add nothing",
      ).toEqual(["0x3000", "0x2000"]);
      expect(
        execution.limitations,
        "a populated callees reply needs no completeness warning",
      ).not.toContain(EMPTY_CALLEES_LIMITATION);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("appends graph-only callees after the callees items, sorted by address", async () => {
    const { client } = await session({
      callees: [{ addr: "0x3000", name: "printf_stub", type: "internal" }],
      callgraph: graphRow([edge("0x1000", "0x4000"), edge("0x1000", "0x2000")]),
    });
    try {
      const execution = await callees(client);

      expect(
        execution.result,
        "existing items first, then the additions in address order",
      ).toEqual(["0x3000", "0x2000", "0x4000"]);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});

describe("headless IDA call graph degradation", () => {
  it.each([
    [
      "a failing call graph tool",
      { callgraphFailure: "unknown tool callgraph" },
    ],
    [
      "an error row",
      {
        callgraph: [
          { root: "0x1000", error: "Function not found", nodes: [], edges: [] },
        ] as JsonValue,
      },
    ],
    ["an unreadable reply", { callgraph: { unexpected: true } as JsonValue }],
  ])(
    "keeps the callees observation and says the graph was unavailable for %s",
    async (_label, graph) => {
      const { client } = await session({
        callees: [{ addr: "0x3000", name: "printf_stub", type: "internal" }],
        ...graph,
      });
      try {
        const execution = await callees(client);

        expect(execution.result, "the observed callee survives").toEqual([
          "0x3000",
        ]);
        expect(
          execution.limitations.some((text) =>
            text.startsWith("Upstream callgraph was unavailable ("),
          ),
          "the failure is visible as a limitation",
        ).toBe(true);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );

  it.each([
    ["a truncated graph", { truncated: true, limit_reason: "edges" }],
    ["a saturated per-function cap", { max_edges_per_func: 2 }],
  ])("keeps the edges seen and reports %s", async (_label, extra) => {
    const { client } = await session({
      callees: [],
      callgraph: graphRow(
        [edge("0x1000", "0x2000"), edge("0x1000", "0x3000")],
        extra,
      ),
    });
    try {
      const execution = await callees(client);

      expect(execution.result, "the observed edges are kept").toEqual([
        "0x2000",
        "0x3000",
      ]);
      expect(
        execution.limitations,
        "omitted callees are reported as unknown",
      ).toContain(
        "Upstream callgraph was truncated; additional callees remain unknown.",
      );
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("takes the call graph path for a universal target whose loaded slice is unknown", async () => {
    const { client, producer } = await session(
      { callees: [], callgraph: graphRow([edge("0x1000", "0x2000")]) },
      "x86_64",
      ["x86_64", "arm64"],
    );
    try {
      const execution = await callees(client);

      expect(execution.result, "the graph edge is observed").toEqual([
        "0x2000",
      ]);
      expect(
        producer.calls.some(({ name }) => name === "callgraph"),
        "a mixed universal target cannot prove an x86 slice",
      ).toBe(true);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("stops at once when the caller cancels during the call graph request", async () => {
    const controller = new AbortController();
    const { client, producer } = await session({
      callees: [],
      callgraph: graphRow([edge("0x1000", "0x2000")]),
    });
    const inner = producer.beforeCall;
    producer.beforeCall = async (name, args) => {
      await inner?.(name, args);
      if (name === "callgraph") controller.abort();
    };
    try {
      const result = await client.execute(
        "procedure_callees",
        { procedure: "main" },
        { signal: controller.signal },
      );

      if (result.ok) throw new Error("expected cancellation");
      expect(result.error._tag, "cancellation is not swallowed").toBe(
        "AnalysisCancelledError",
      );
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});

describe("headless IDA callee edges on x86 targets", () => {
  it("keeps the request sequence, result and limitations of an x86 read unchanged", async () => {
    const { client, producer } = await session(
      {
        callees: [
          { addr: "0x2000", name: "imported_puts", type: "external" },
          { addr: "0x3000", name: "printf_stub", type: "internal" },
        ],
      },
      "x86_64",
    );
    try {
      const execution = await callees(client);

      expect(
        execution.result,
        "externals come first, then resolved internals, exactly as before",
      ).toEqual(["0x2000", "0x3000"]);
      expect(
        execution.limitations,
        "no limitation is added on x86",
      ).not.toContain(EMPTY_CALLEES_LIMITATION);
      expect(
        producer.calls.map(({ name }) => name),
        "no call graph request is made on an x86-only target",
      ).toEqual([
        "idb_open",
        "idb_list",
        "server_health",
        "lookup_funcs",
        "callees",
        "lookup_funcs",
        "server_health",
      ]);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});
