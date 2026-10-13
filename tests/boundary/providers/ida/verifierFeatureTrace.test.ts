import { describe, expect, it } from "vitest";
// @ts-expect-error The verifier library is plain JavaScript without declarations.
import { assertFeatureTrace } from "../../../../scripts/lib/ida-feature-trace.mjs";

const procedure = { address: "0x1000", name: "main" };

const containing = (found: boolean) =>
  found
    ? {
        query_address: "0x1004",
        found: true,
        procedure: { address: "0x1000", name: "main" },
      }
    : {
        query_address: "0x3010",
        found: false,
        procedure: null,
        reason: "not_in_procedure",
      };

const trace = (
  matches: readonly { type: string; address: string }[],
  references: readonly {
    target_address: string;
    containing_procedure: unknown;
  }[],
) => ({
  query: "main",
  search_mode: "literal",
  matches,
  references,
  truncated: false,
  residual_unknowns: [],
});

const SELECTED = { type: "procedure", address: "0x1000" };
const SUBSTRING = { type: "procedure", address: "0x2000" };
const STRING = { type: "string", address: "0x3000" };

describe("the real IDA lane's feature trace assertions", () => {
  it("accepts references to every matched address, whoever contains the source", () => {
    expect(() =>
      assertFeatureTrace(
        trace(
          [SELECTED, SUBSTRING, STRING],
          [
            {
              target_address: "0x1000",
              containing_procedure: containing(true),
            },
            // A substring match such as main_helper, referenced from code.
            {
              target_address: "0x2000",
              containing_procedure: containing(true),
            },
            // A string containing the query, referenced from data outside functions.
            {
              target_address: "0x3000",
              containing_procedure: containing(false),
            },
          ],
        ),
        procedure,
      ),
    ).not.toThrow();
  });

  it("accepts a reference to the selected procedure from data outside functions", () => {
    expect(() =>
      assertFeatureTrace(
        trace(
          [SELECTED],
          [
            {
              target_address: "0x1000",
              containing_procedure: containing(false),
            },
          ],
        ),
        procedure,
      ),
    ).not.toThrow();
  });

  it("rejects a reference whose target is not one of the matches", () => {
    expect(() =>
      assertFeatureTrace(
        trace(
          [SELECTED],
          [
            {
              target_address: "0x9999",
              containing_procedure: containing(true),
            },
          ],
        ),
        procedure,
      ),
    ).toThrow();
  });

  it("rejects a trace without the selected procedure's match", () => {
    expect(() => assertFeatureTrace(trace([STRING], []), procedure)).toThrow();
  });

  it("rejects a containment answer that is neither found nor a known reason", () => {
    expect(() =>
      assertFeatureTrace(
        trace(
          [SELECTED],
          [
            {
              target_address: "0x1000",
              containing_procedure: {
                query_address: "0x1004",
                found: false,
                procedure: null,
                reason: "unknown",
              },
            },
          ],
        ),
        procedure,
      ),
    ).toThrow();
  });

  it("rejects a trace that does not say whether it was truncated", () => {
    expect(() =>
      assertFeatureTrace(
        { ...trace([SELECTED], []), truncated: undefined },
        procedure,
      ),
    ).toThrow();
  });
});
