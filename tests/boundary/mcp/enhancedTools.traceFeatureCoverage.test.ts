import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ok } from "../../../src/domain/result.js";

import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

const PROVIDER = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const;

type Coverage = boolean | undefined;

/**
 * A provider with two string matches. Each match has one reference; the
 * `coverage` map says what the provider reports for that target's references:
 * `true` for a capped read, `false` for an explicitly complete one, and
 * undefined for a provider that reports nothing.
 */
const provider = (
  coverage: Readonly<Record<string, Coverage>>,
  limitations: readonly string[] = [],
): AnalysisOperationPort => ({
  execute: async (name, arguments_) => {
    const address = String(arguments_.address);
    switch (name) {
      case "search_strings":
        return ok(
          createAnalysisExecution(
            [
              { address: "0x10", value: "hello" },
              { address: "0x11", value: "hello again" },
            ],
            PROVIDER,
          ),
        );
      case "search_procedures":
        return ok(createAnalysisExecution([], PROVIDER));
      case "xrefs": {
        const reported = coverage[address];
        return ok(
          createAnalysisExecution(
            [address === "0x10" ? "0x20" : "0x21"],
            PROVIDER,
            {
              limitations,
              ...(reported === undefined
                ? {}
                : { referencesTruncated: reported }),
            },
          ),
        );
      }
      case "resolve_containing_procedure":
        return ok(
          createAnalysisExecution(
            {
              query_address: address,
              found: false,
              procedure: null,
              reason: "not_in_procedure",
            },
            PROVIDER,
          ),
        );
      default:
        throw new Error(`Unexpected operation: ${name}`);
    }
  },
});

const trace = async (analysis: AnalysisOperationPort) => {
  const client = await connect(analysis);
  const result = await client.callTool({
    name: "trace_feature",
    arguments: { query: "hello" },
  });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as {
    normalized_result: {
      references: unknown[];
      truncated: boolean;
      residual_unknowns: string[];
    };
  };
};

describe("trace_feature reference coverage", () => {
  it("marks the trace truncated for the target whose references the provider capped", async () => {
    const output = await trace(provider({ "0x10": true, "0x11": false }));

    expect(
      output.normalized_result,
      "the returned references are kept and only the capped target is a residual unknown",
    ).toMatchObject({
      references: [
        { target_address: "0x10", source_address: "0x20" },
        { target_address: "0x11", source_address: "0x21" },
      ],
      truncated: true,
      residual_unknowns: [
        "References to 0x10 were truncated by the provider; additional references may exist.",
      ],
    });
  });

  it("keeps the trace complete when the provider explicitly reports no cap", async () => {
    const output = await trace(provider({ "0x10": false, "0x11": false }));

    expect(output.normalized_result).toMatchObject({
      truncated: false,
      residual_unknowns: [],
    });
  });

  it("does not change the trace of a provider that reports no coverage", async () => {
    const output = await trace(
      provider({}, ["Upstream xrefs_to capped results at 1000 references."]),
    );

    expect(
      output.normalized_result,
      "a limitation text alone never truncates, and an absent field keeps the previous result",
    ).toEqual({
      query: "hello",
      search_mode: "literal",
      matches: [
        { type: "string", address: "0x10", value: "hello" },
        { type: "string", address: "0x11", value: "hello again" },
      ],
      references: [
        {
          target_address: "0x10",
          source_address: "0x20",
          containing_procedure: {
            query_address: "0x20",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          },
        },
        {
          target_address: "0x11",
          source_address: "0x21",
          containing_procedure: {
            query_address: "0x21",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          },
        },
      ],
      truncated: false,
      residual_unknowns: [],
    });
  });

  it("never exposes the coverage field in the tool output", async () => {
    const output = await trace(provider({ "0x10": true, "0x11": false }));

    expect(JSON.stringify(output)).not.toContain("referencesTruncated");
  });
});
