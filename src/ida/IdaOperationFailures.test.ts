import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { IdaSessionClient } from "./IdaSessionClient.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("headless IDA operation failures", () => {
  it.each<{
    tool: string;
    operation: AnalysisOperation;
    parameters: Readonly<Record<string, JsonValue>>;
    response: JsonValue;
  }>([
    {
      tool: "decompile",
      operation: "procedure_pseudo_code",
      parameters: { procedure: "main" },
      response: { code: "partial pseudocode", cursor: { done: true } },
    },
    {
      tool: "xrefs_to",
      operation: "xrefs",
      parameters: { address: "0x1000" },
      response: [{ xrefs: [], more: false }],
    },
    {
      tool: "callees",
      operation: "procedure_callees",
      parameters: { procedure: "main" },
      response: [{ callees: [], more: false }],
    },
    {
      tool: "decompile",
      operation: "analyze_function",
      parameters: { procedure: "main" },
      response: { code: "partial pseudocode", cursor: { done: true } },
    },
    {
      tool: "callees",
      operation: "analyze_function",
      parameters: { procedure: "main" },
      response: [{ callees: [], more: false }],
    },
  ])(
    "preserves $tool failure through $operation when the producer also supplies preview data",
    async ({ tool, operation, parameters, response }) => {
      const { root, target } = await createIdaTarget();
      roots.push(root);
      const producer = new RecordingIdaMcp(target, "headless");
      const failure =
        "Database analysis interrupted while reading observations";
      producer.overrideCall = (name) => {
        if (name !== tool) return undefined;
        const withError = (value: JsonValue): JsonValue => {
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
          )
            throw new TypeError("Invalid operation fixture");
          return { ...value, error: failure };
        };
        return Array.isArray(response)
          ? response.map(withError)
          : withError(response);
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
      try {
        const result = await client.execute(operation, parameters);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain(failure);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});

const lookup = (query: string, fn: JsonValue, error: string | null) => [
  { query, fn, error },
];
const knownFunction = { addr: "0x1000", name: "main", size: "0x20" };

const missingProcedureFixture = async (
  answer: (query: string) => JsonValue | undefined,
) => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, "headless");
  producer.overrideCall = (name, args) => {
    if (name !== "lookup_funcs") return undefined;
    const queries = args.queries;
    const query = Array.isArray(queries) ? String(queries[0]) : "";
    return answer(query);
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
  return client;
};

describe("headless IDA procedure lookup failures", () => {
  it.each([
    ["Not found", "procedure_pseudo_code"],
    ["Not found", "procedure_address"],
    ["Not found", "analyze_function"],
    ["Not a function", "procedure_pseudo_code"],
    ["Not a function", "read_function_instructions"],
  ] as const)(
    "reports the upstream %s answer for %s as an invalid request naming the procedure",
    async (upstream, operation) => {
      const client = await missingProcedureFixture((query) =>
        lookup(query, null, upstream),
      );
      try {
        const result = await client.execute(operation, { procedure: "main" });

        if (result.ok) throw new Error("expected invalid input");
        expect(result.error._tag, "the caller's procedure is the fault").toBe(
          "AnalysisInputError",
        );
        const projected = projectAnalysisError(result.error);
        expect(projected.code, "the public code is invalid_request").toBe(
          "invalid_request",
        );
        expect(projected.category, "the category is invalid_input").toBe(
          "invalid_input",
        );
        expect(projected.retryable, "the caller can correct and retry").toBe(
          true,
        );
        expect(
          JSON.stringify(projected),
          "the queried procedure and the upstream text are reported",
        ).toContain("main");
        expect(JSON.stringify(projected), "upstream text kept").toContain(
          upstream,
        );
        expect(
          JSON.stringify(projected).toLowerCase(),
          "no retry or doctor advice for a caller mistake",
        ).not.toMatch(/doctor|retry once/u);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );

  it.each([
    ["an upstream exception text", lookup("main", null, "Database is closed")],
    ["a function with an error", lookup("main", knownFunction, "Not found")],
    ["neither a function nor an error", lookup("main", null, null)],
    [
      "a near-miss spelling of the not-found text",
      lookup("main", null, "not found"),
    ],
  ])("keeps %s as unreadable output", async (_label, answer) => {
    const client = await missingProcedureFixture(() => answer);
    try {
      const result = await client.execute("procedure_pseudo_code", {
        procedure: "main",
      });

      if (result.ok) throw new Error("expected unreadable output");
      expect(
        projectAnalysisError(result.error).code,
        "unknown beats a wrong fact about the caller's input",
      ).toBe("unreadable_output");
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("keeps an unresolvable callee reported by IDA itself as unreadable output", async () => {
    const { root, target } = await createIdaTarget();
    roots.push(root);
    const producer = new RecordingIdaMcp(target, "headless");
    producer.overrideCall = (name, args) => {
      if (name === "callees")
        return [
          {
            callees: [{ addr: "0x2000", name: "sub_2000", type: "internal" }],
            more: false,
          },
        ];
      if (name !== "lookup_funcs") return undefined;
      const queries = args.queries;
      const query = Array.isArray(queries) ? String(queries[0]) : "";
      return query === "0x2000"
        ? lookup(query, null, "Not a function")
        : lookup(query, knownFunction, null);
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
    try {
      const result = await client.execute("procedure_callees", {
        procedure: "main",
      });

      if (result.ok) throw new Error("expected unreadable output");
      expect(
        projectAnalysisError(result.error).code,
        "an address IDA itself reported is not the caller's mistake",
      ).toBe("unreadable_output");
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});
