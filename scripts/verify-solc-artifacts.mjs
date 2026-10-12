#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { mcpTextValue } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import {
  createSolcFixtureOutputs,
  sourceUnit,
  compilerVersion,
} from "./fixtures/solidity/compiler-artifacts.mjs";

const modulePath = process.env.REA_VERIFY_SOLC_MODULE;
if (!isAbsolute(modulePath ?? ""))
  throw new Error(
    "Select unchanged solc 0.8.30 with absolute REA_VERIFY_SOLC_MODULE; this verifier compiles its own fixture only.",
  );
const { linked, unlinked, failedCompile } =
  await createSolcFixtureOutputs(modulePath);
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("./rea.mjs", import.meta.url));
const execute = promisify(execFile);
const run = createVerifierRun();
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const root = await PrivateRuntimeRoot.create({ prefix: "rea-solc-verifier-" });
const client = new Client({ name: "solc-artifact-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
let transportDiagnostics = "";
transport.stderr?.on("data", (chunk) => {
  transportDiagnostics = (transportDiagnostics + chunk.toString()).slice(-4096);
});
const failures = [];
let cases = 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let inputSchema, outputSchema, validate;
try {
  await client.connect(transport);
  const definition = (await client.listTools()).tools.find(
    ({ name }) => name === "inspect_evm_interface",
  );
  assert.ok(definition?.outputSchema, "Missing named EVM output schema");
  inputSchema = definition.inputSchema;
  outputSchema = definition.outputSchema;
  validate = new Ajv2020({ strict: false, validateFormats: false });
  for (const schema of [inputSchema, outputSchema])
    assert.ok(validate.validateSchema(schema), JSON.stringify(validate.errors));
  const inspect = async (mode, path, encoding, options = {}) => {
    const {
      selection,
      expectedError = false,
      expectedCategory = "invalid_input",
      detail,
    } = options;
    const input = {
      path,
      encoding:
        encoding === "solc-json"
          ? { kind: "solc-json", ...selection }
          : encoding,
      ...(detail === undefined ? {} : { detail }),
    };
    if (!expectedError)
      assert.ok(
        validate.validate(inputSchema, input),
        JSON.stringify(validate.errors),
      );
    let value;
    if (mode === "mcp") {
      const reply = await client.callTool({
        name: "inspect_evm_interface",
        arguments: input,
      });
      if (expectedError) {
        assert.equal(reply.isError, true, mcpTextValue(reply));
        let schemaRejected = false;
        try {
          value = JSON.parse(mcpTextValue(reply));
        } catch {
          assert.equal(validate.validate(inputSchema, input), false);
          assert.match(mcpTextValue(reply), /^Input validation\b/u);
          schemaRejected = true;
          value = { validation_error: mcpTextValue(reply) };
        }
        if (!schemaRejected) assertTypedFailure(value.error, expectedCategory);
        cases++;
        return value;
      }
      value = JSON.parse(mcpTextValue(reply));
      assert.notEqual(reply.isError, true, JSON.stringify(value));
      assert.ok(
        validate.validate(outputSchema, reply.structuredContent),
        JSON.stringify(validate.errors),
      );
    } else {
      const args = [
        entrypoint,
        "inspect-evm-interface",
        path,
        encoding,
        "--json",
      ];
      if (selection !== undefined)
        args.push(
          "--source-unit",
          selection.source_unit,
          "--contract-name",
          selection.contract_name,
          "--bytecode-kind",
          selection.bytecode_kind,
        );
      if (detail !== undefined) args.push("--detail", detail);
      let failed = false,
        stdout;
      try {
        ({ stdout } = await execute(process.execPath, args, {
          env: environment,
          timeout: 45_000,
          maxBuffer: 32 * 1024 * 1024,
        }));
      } catch (cause) {
        if (typeof cause.code !== "number" || typeof cause.stdout !== "string")
          throw cause;
        failed = true;
        stdout = cause.stdout;
      }
      value = JSON.parse(stdout);
      if (expectedError) {
        assert.equal(failed, true, JSON.stringify(value));
        assertTypedFailure(value, expectedCategory);
        cases++;
        return value;
      }
      assert.equal(failed, false, JSON.stringify(value));
    }
    const evidence = parseEvidence(value);
    cases++;
    if (detail !== "summary")
      await assertIdentity(evidence, {
        ...input,
        encoding,
        compiler_selection: selection,
      });
    return evidence;
  };
  const assertIdentity = async (
    evidence,
    { path, encoding, compiler_selection: selection },
  ) => {
    const report = evidence.normalized_result;
    const carrier = await readFile(path);
    assert.equal(report.artifact.sha256, sha256(carrier));
    assert.equal(report.artifact.bytes, carrier.length);
    assert.equal(report.artifact.encoding, encoding);
    assert.equal(report.runtime_execution, "not-performed");
    assert.equal(evidence.subject.digest.sha256, sha256(carrier));
    if (report.bytecode.hex !== null) {
      assert.equal(report.bytecode.bytes, report.bytecode.hex.length / 2);
      assert.equal(
        report.bytecode.sha256,
        sha256(Buffer.from(report.bytecode.hex, "hex")),
      );
    }
    if (selection !== undefined) {
      assert.equal(report.bytecode.kind, selection.bytecode_kind);
      assert.ok(report.compiler_artifact);
      assert.deepEqual(report.compiler_artifact.selection, selection);
    }
  };
  const assertCompiler = async (
    report,
    expected,
    { contractName, kind, linkedPath },
  ) => {
    const compiler = report.compiler_artifact;
    const originalText = await readFile(linkedPath, "utf8");
    assert.equal(
      JSON.parse(
        originalText.slice(
          compiler.object_range.start,
          compiler.object_range.end,
        ),
      ),
      expected,
    );
    assert.equal(compiler.object_range.unit, "utf16-code-unit");
    assert.equal(compiler.object, expected);
    assert.equal(
      compiler.metadata.raw,
      linked.contracts[sourceUnit][contractName].metadata,
    );
    assert.equal(compiler.metadata.compiler_version, "0.8.30+commit.73712a01");
    const escaped = sourceUnit.replace(/~/gu, "~0").replace(/\//gu, "~1");
    assert.equal(
      compiler.json_pointer,
      `/contracts/${escaped}/${contractName}/evm/${kind === "creation" ? "bytecode" : "deployedBytecode"}`,
    );
    for (const diagnostic of compiler.diagnostics)
      assert.equal(
        originalText.slice(
          diagnostic.source_range.start,
          diagnostic.source_range.end,
        ),
        diagnostic.raw_json,
      );
    if (contractName === "LinkedFixture" && kind === "deployed")
      assert.ok(compiler.immutable_references.length > 0);
  };
  const linkedPath = join(root.path, "linked.json");
  const unlinkedPath = join(root.path, "unlinked.json");
  await writeFile(linkedPath, JSON.stringify(linked, null, 2));
  await writeFile(unlinkedPath, JSON.stringify(unlinked, null, 2));
  for (const contractName of [
    "FirstFixture",
    "SecondFixture",
    "LinkedFixture",
  ]) {
    for (const kind of ["creation", "deployed"]) {
      const selection = {
        source_unit: sourceUnit,
        contract_name: contractName,
        bytecode_kind: kind,
      };
      const expected =
        linked.contracts[sourceUnit][contractName].evm[
          kind === "creation" ? "bytecode" : "deployedBytecode"
        ].object;
      const rawPath = join(root.path, `${contractName}-${kind}.raw`);
      const hexPath = join(root.path, `${contractName}-${kind}.hex`);
      await writeFile(rawPath, Buffer.from(expected, "hex"));
      await writeFile(hexPath, "0x" + expected);
      const raw = (await inspect("cli", rawPath, "raw")).normalized_result;
      const hex = (await inspect("mcp", hexPath, "hex")).normalized_result;
      assert.deepEqual(raw.functions, hex.functions);
      for (const mode of ["cli", "mcp"]) {
        const evidence = await inspect(mode, linkedPath, "solc-json", {
          selection,
        });
        const report = evidence.normalized_result;
        assert.equal(report.bytecode.hex, expected);
        assert.deepEqual(report.functions, raw.functions);
        assert.equal(report.inference_status, "examined");
        assert.deepEqual(
          report.compiler_artifact.diagnostics.map(({ raw_json }) =>
            JSON.parse(raw_json),
          ),
          linked.errors,
        );
        await assertCompiler(report, expected, {
          contractName,
          kind,
          linkedPath,
        });
      }
    }
  }
  for (const kind of ["creation", "deployed"]) {
    const selection = {
      source_unit: sourceUnit,
      contract_name: "LinkedFixture",
      bytecode_kind: kind,
    };
    const expected =
      unlinked.contracts[sourceUnit].LinkedFixture.evm[
        kind === "creation" ? "bytecode" : "deployedBytecode"
      ].object;
    assert.match(expected, /__\$[a-f0-9]{34}\$__/u);
    for (const mode of ["cli", "mcp"]) {
      const report = (
        await inspect(mode, unlinkedPath, "solc-json", { selection })
      ).normalized_result;
      assert.equal(report.bytecode.hex, null);
      assert.equal(report.bytecode.sha256, null);
      assert.equal(report.bytecode.bytes, expected.length / 2);
      assert.equal(report.inference_status, "unavailable");
      assert.equal(report.compiler_artifact.object, expected);
      assert.ok(report.compiler_artifact.link_references.length > 0);
      assert.ok(report.compiler_artifact.placeholders.length > 0);
      for (const placeholder of report.compiler_artifact.placeholders)
        assert.equal(
          expected.slice(
            placeholder.start * 2,
            (placeholder.start + placeholder.length) * 2,
          ),
          placeholder.value,
        );
      assert.ok(report.limitations.length > 0);
    }
  }
  const selection = {
    source_unit: sourceUnit,
    contract_name: "LinkedFixture",
    bytecode_kind: "deployed",
  };
  const absent = structuredClone(linked);
  delete absent.contracts[sourceUnit].LinkedFixture.evm.deployedBytecode;
  const absentPath = join(root.path, "absent-object.json");
  await writeFile(absentPath, JSON.stringify(absent));
  for (const mode of ["cli", "mcp"]) {
    const report = (await inspect(mode, absentPath, "solc-json", { selection }))
      .normalized_result;
    assert.equal(report.bytecode.bytes, null);
    assert.equal(report.bytecode.hex, null);
    assert.equal(report.inference_status, "unavailable");
  }
  // A real failed compilation has errors and no contract objects.
  const failedPath = join(root.path, "compiler-error-only.json");
  await writeFile(failedPath, JSON.stringify(failedCompile));
  for (const mode of ["cli", "mcp"]) {
    const failure = await inspect(mode, failedPath, "solc-json", {
      selection,
      expectedError: true,
    });
    const projected = mode === "mcp" ? failure.error : failure;
    assert.equal(projected.category, "invalid_input");
    const diagnostics = projected.details.diagnostics;
    assert.equal(
      diagnostics.carrier_sha256,
      sha256(await readFile(failedPath)),
    );
    assert.deepEqual(diagnostics.compiler_selection, selection);
    assert.deepEqual(
      diagnostics.compiler_diagnostics.map(({ raw_json }) =>
        JSON.parse(raw_json),
      ),
      failedCompile.errors,
    );
  }
  // Synthetic unsupported bytecode uses real compiler diagnostics unchanged.
  const eof = structuredClone(linked);
  eof.errors = failedCompile.errors;
  eof.contracts[sourceUnit].FirstFixture.evm.deployedBytecode.object = "ef0001";
  const eofPath = join(root.path, "unsupported-eof.json");
  await writeFile(eofPath, JSON.stringify(eof));
  const eofSelection = { ...selection, contract_name: "FirstFixture" };
  for (const mode of ["cli", "mcp"]) {
    const failure = await inspect(mode, eofPath, "solc-json", {
      selection: eofSelection,
      expectedError: true,
      expectedCategory: "unsupported_target",
    });
    const diagnostics = (mode === "mcp" ? failure.error : failure).details
      .diagnostics;
    assert.equal(diagnostics.carrier_sha256, sha256(await readFile(eofPath)));
    assert.deepEqual(diagnostics.compiler_selection, eofSelection);
    assert.deepEqual(
      diagnostics.compiler_diagnostics.map(({ raw_json }) =>
        JSON.parse(raw_json),
      ),
      failedCompile.errors,
    );
  }
  const invalidReferences = structuredClone(linked);
  invalidReferences.contracts[
    sourceUnit
  ].LinkedFixture.evm.deployedBytecode.immutableReferences = {
    0: [{ start: 0, length: Number.MAX_SAFE_INTEGER }],
  };
  const invalidPath = join(root.path, "invalid-reference.json");
  await writeFile(invalidPath, JSON.stringify(invalidReferences));
  const duplicatePath = join(root.path, "duplicate-properties.json");
  await writeFile(duplicatePath, '{"contracts":{},"contracts":{}}');
  for (const mode of ["cli", "mcp"]) {
    await inspect(mode, linkedPath, "solc-json", { expectedError: true });
    await inspect(mode, linkedPath, "solc-json", {
      selection: { ...selection, source_unit: "compiler-artifacts.sol" },
      expectedError: true,
    });
    await inspect(mode, linkedPath, "solc-json", {
      selection: { ...selection, contract_name: "MissingFixture" },
      expectedError: true,
    });
    await inspect(mode, invalidPath, "solc-json", {
      selection,
      expectedError: true,
    });
    await inspect(mode, duplicatePath, "solc-json", {
      selection,
      expectedError: true,
    });
  }
  const invalidRawInput = {
    path: linkedPath,
    encoding: "hex",
    compiler_selection: selection,
  };
  assert.equal(validate.validate(inputSchema, invalidRawInput), false);
  const rawRejection = await client.callTool({
    name: "inspect_evm_interface",
    arguments: invalidRawInput,
  });
  assert.equal(rawRejection.isError, true);
  assert.match(mcpTextValue(rawRejection), /^Input validation\b/u);
  cases++;
  const summary = await inspect("mcp", linkedPath, "solc-json", {
    selection,
    detail: "summary",
  });
  const view = summary.normalized_result;
  assert.ok(view.parent_evidence_id);
  assert.ok(JSON.stringify(view.summary).includes(sourceUnit));
  assert.equal(view.summary.compiler_artifact.object, undefined);
  assert.equal(view.summary.compiler_artifact.metadata.raw, undefined);
  assert.equal(
    view.summary.compiler_artifact.object_code_units,
    linked.contracts[sourceUnit].LinkedFixture.evm.deployedBytecode.object
      .length,
  );
  assert.equal(
    view.summary.compiler_artifact.metadata.raw_code_units,
    linked.contracts[sourceUnit].LinkedFixture.metadata.length,
  );
  const bundlePath = join(root.path, "retained.json");
  const exported = await client.callTool({
    name: "export_evidence_bundle",
    arguments: { path: bundlePath },
  });
  assert.notEqual(exported.isError, true, mcpTextValue(exported));
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const parent = bundle.records.find(
    ({ evidence_id }) => evidence_id === view.parent_evidence_id,
  );
  assert.ok(parent, "Summary parent missing from retained Evidence");
  assert.equal(
    parent.normalized_result.bytecode.hex,
    linked.contracts[sourceUnit].LinkedFixture.evm.deployedBytecode.object,
  );
  assert.deepEqual(
    parent.normalized_result.compiler_artifact.selection,
    selection,
  );
  cases++;
} catch (cause) {
  if (transportDiagnostics)
    failures.push(new Error("MCP diagnostic output: " + transportDiagnostics));
  failures.push(cause);
} finally {
  for (const close of [
    () => client.close(),
    () => transport.close(),
    () => root.close(),
  ]) {
    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }
}
const verifier = await completeVerifierRun(run);
if (
  verifier.process_lineage.status !== "verified" ||
  verifier.process_lineage.descendants.length !== 0
)
  failures.push(
    new Error("Verifier lineage was not released: " + JSON.stringify(verifier)),
  );
console.log(
  JSON.stringify(
    {
      status: failures.length === 0 ? "passed" : "failed",
      public_cases: cases,
      compiler: compilerVersion,
      engine: "evmole@0.9.3",
      fixture_target_execution: "not-performed",
      network_observation: "not-measured",
      verifier,
    },
    null,
    2,
  ),
);
if (failures.length)
  throw new AggregateError(
    failures,
    "Solidity artifact public verification failed; cleanup failures retained.",
  );

function assertTypedFailure(value, expectedCategory) {
  assert.equal(value.category, expectedCategory);
  assert.equal(
    value.code,
    expectedCategory === "unsupported_target"
      ? "unsupported_target"
      : "invalid_request",
  );
}
