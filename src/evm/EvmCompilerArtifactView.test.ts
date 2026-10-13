import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { evmInterfaceFixture } from "../../tests/fixtures/evm/interface.js";
import {
  inspectEvmInterfaceInputSchema,
  type EvmInterface,
} from "../domain/evm/evmInterface.js";
import { selectSolcArtifact } from "../domain/evm/solcArtifactSelection.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "../domain/analysisView/analysisView.js";

const compilerParent = (object?: string): AnalysisViewParent => {
  const selection = {
    source_unit: "a.sol",
    contract_name: "C",
    bytecode_kind: "creation" as const,
  };
  const selected = selectSolcArtifact(
    new TextEncoder().encode(
      JSON.stringify({
        contracts: {
          "a.sol": {
            C: {
              evm: { bytecode: object === undefined ? {} : { object } },
              metadata: JSON.stringify({
                compiler: { version: "0.8.30" },
                settings: { optimizer: { enabled: true } },
              }),
            },
          },
        },
        errors: [
          { severity: "error", message: "Recorded compiler diagnostic" },
        ],
      }),
    ),
    selection,
  );
  if (!selected.ok) throw selected.error;
  const decodedHex =
    selected.value.bytes === null
      ? null
      : Buffer.from(selected.value.bytes).toString("hex");
  const report: EvmInterface = {
    ...evmInterfaceFixture(),
    artifact: {
      ...evmInterfaceFixture().artifact,
      encoding: "solc-json" as const,
    },
    bytecode: {
      ...evmInterfaceFixture().bytecode,
      kind: "creation" as const,
      hex: decodedHex,
      sha256:
        decodedHex === null
          ? null
          : createHash("sha256")
              .update(Buffer.from(decodedHex, "hex"))
              .digest("hex"),
      bytes: selected.value.byteLength,
    },
    compiler_artifact: selected.value.artifact,
    inference_status:
      selected.value.bytes === null ? "unavailable" : "examined",
  };
  return {
    evidenceId: "ev_" + "b".repeat(64),
    operation: "inspect_evm_interface",
    parameters: {
      path: report.artifact.path,
      encoding: { kind: "solc-json", ...selection },
    },
    normalizedResult: report,
    subject: {
      name: "compiler output",
      architecture: null,
      local_path: report.artifact.path,
      digest: { sha256: report.artifact.sha256 },
      format: "file",
    },
    limitations: report.limitations,
  };
};

it.each([
  undefined,
  "__$" + "a".repeat(34) + "$__",
  `__雪.sol:L${"_".repeat(27)}__`,
])(
  "retains compiler diagnostics and unknown inference coverage for object %s",
  (object) => {
    const parent = compilerParent(object);
    const result = projectAnalysisView(parent, { kind: "summary" });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      coverage: {
        status: "unknown",
        examined: 0,
        total: null,
        exhausted: null,
      },
      summary: {
        inference_status: "unavailable",
        bytecode: { kind: "creation", sha256: null },
        compiler_artifact: {
          selection: {
            source_unit: "a.sol",
            contract_name: "C",
            bytecode_kind: "creation",
          },
          object_code_units: object?.length ?? null,
          metadata: {
            compiler_version: "0.8.30",
            parse_status: "valid",
            raw_code_units: expect.any(Number),
            settings_json: expect.any(String),
          },
          diagnostics: [
            {
              severity: "error",
              raw_json: expect.stringContaining("Recorded compiler diagnostic"),
            },
          ],
        },
      },
    });
    const summary =
      "summary" in result.value
        ? (result.value.summary as {
            compiler_artifact: Record<string, unknown>;
          })
        : undefined;
    expect(summary?.compiler_artifact).not.toHaveProperty("object");
    expect(summary?.compiler_artifact.metadata).not.toHaveProperty("raw");
    expect(
      (parent.normalizedResult as EvmInterface).compiler_artifact?.object,
    ).toBe(object ?? null);
    expect(
      (parent.normalizedResult as EvmInterface).compiler_artifact?.metadata.raw,
    ).toContain("0.8.30");
    expect(result.value.unknowns.join(" ")).not.toContain("bytecode kind");
    const functions = projectAnalysisView(parent, {
      kind: "evm",
      facet: "functions",
      offset: 0,
      limit: 1,
    });
    if (!functions.ok) throw functions.error;
    expect(functions.value).toMatchObject({
      item: [],
      coverage: { status: "unknown", total: null, exhausted: null },
    });
  },
);

it("rejects unavailable decoded hex without returning an empty text page", () => {
  const result = projectAnalysisView(compilerParent(), {
    kind: "evm",
    facet: "bytecode_hex",
    offset: 0,
    limit: 64,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected unavailable bytecode failure");
  expect(result.error).toMatchObject({
    _tag: "AnalysisInputError",
    issues: [
      {
        path: ["view", "facet"],
        message: expect.stringContaining("unavailable"),
      },
    ],
  });
});

it.each([undefined, {}])(
  "keeps historical hex views with missing parameters complete within returned candidates and kind unknown: %j",
  (parameters) => {
    const result = projectAnalysisView(
      {
        ...compilerParent(),
        normalizedResult: evmInterfaceFixture(),
        parameters,
      },
      { kind: "summary" },
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      coverage: { status: "complete-within-view", total: 0, exhausted: true },
      summary: { bytecode: { kind: "unknown" } },
    });
    expect(result.value.unknowns.join(" ")).toContain("bytecode kind");
  },
);

it("rejects conflicting equal-length compiler bytes or decoded digest in inline views", () => {
  for (const conflict of ["object", "digest"] as const) {
    const parent = compilerParent("6001");
    const report = parent.normalizedResult as EvmInterface;
    if (conflict === "object") {
      report.bytecode.hex = "6002";
      report.bytecode.sha256 = createHash("sha256")
        .update(Buffer.from("6002", "hex"))
        .digest("hex");
    } else report.bytecode.sha256 = "c".repeat(64);
    expect(projectAnalysisView(parent, { kind: "summary" }).ok).toBe(false);
  }
});

it("rejects hex falsely marked as an unresolved compiler placeholder", () => {
  const parent = compilerParent("__$" + "a".repeat(34) + "$__");
  const report = parent.normalizedResult as EvmInterface;
  if (report.compiler_artifact === undefined)
    throw new Error("Compiler artifact missing");
  report.compiler_artifact.object = "a".repeat(40);
  report.compiler_artifact.placeholders[0]!.value = "a".repeat(40);
  expect(projectAnalysisView(parent, { kind: "summary" }).ok).toBe(false);
});

it.each([
  "path",
  "encoding",
  "source_unit",
  "contract_name",
  "bytecode_kind",
] as const)(
  "rejects compiler views whose recorded %s contradicts the selected report",
  (field) => {
    const parent = compilerParent("6001");
    const parameters = inspectEvmInterfaceInputSchema.parse(parent.parameters);
    if (typeof parameters.encoding === "string")
      throw new Error("Compiler selection missing");
    if (field === "path") parameters.path = "/other/carrier.json";
    else if (field === "encoding") parameters.encoding = "hex";
    else if (field === "bytecode_kind")
      parameters.encoding.bytecode_kind = "deployed";
    else parameters.encoding[field] = "Other";
    for (const view of [
      { kind: "summary" },
      { kind: "evm", facet: "functions", offset: 0, limit: 1 },
    ] as const) {
      const result = projectAnalysisView({ ...parent, parameters }, view);
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    }
  },
);

it.each([undefined, { path: "/artifacts/source-owned.hex" }])(
  "rejects compiler summaries without a recorded exact selection: %j",
  (parameters) => {
    expect(
      projectAnalysisView(
        { ...compilerParent("6001"), parameters },
        { kind: "summary" },
      ).ok,
    ).toBe(false);
  },
);

it("rejects placeholder facts with no source compiler object", () => {
  const parent = compilerParent();
  const report = parent.normalizedResult as EvmInterface;
  if (report.compiler_artifact === undefined)
    throw new Error("Compiler artifact missing");
  report.compiler_artifact.placeholders.push({
    start: 0,
    length: 20,
    value: `__$${"a".repeat(34)}$__`,
  });
  expect(projectAnalysisView(parent, { kind: "summary" }).ok).toBe(false);
});
