#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/hopperValues.js";

// Compile source-owned input and inspect it through the production CLI. Never execute it.
if (
  !["darwin", "linux"].includes(process.platform) ||
  !["arm64", "x64"].includes(process.arch)
)
  throw new Error(
    "This fixture requires an AArch64/x86_64 Linux or macOS host.",
  );
if (!process.env.GHIDRA_INSTALL_DIR || !process.env.JAVA_HOME)
  throw new Error(
    "Supply GHIDRA_INSTALL_DIR and JAVA_HOME; the verifier installs no tools.",
  );
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "rea-ghidra-completeness-"));
const source = fileURLToPath(
  new URL("../tests/conformance/c/decompiler-completeness.S", import.meta.url),
);
const cli = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const target = join(root, "probe");
try {
  await execute(process.env.REA_CC ?? "cc", [source, "-o", target]);
  const digest = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
  const { stdout: symbols } = await execute("nm", ["-n", target]);
  const entry = /^([a-fA-F0-9]+)\s+T\s+_?main$/mu.exec(symbols);
  assert.ok(entry, "Independent nm entry address unavailable");
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "function",
      target,
      `0x${BigInt(`0x${entry[1]}`).toString(16)}`,
      "--provider",
      "ghidra",
      "--full-output",
      "--json",
    ],
    {
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
      timeout: 240_000,
      maxBuffer: 32 * 1024 ** 2,
    },
  );
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true);
  const evidence = parseEvidence(envelope.data);
  const dossier = functionDossierSchema.parse(evidence.normalized_result);
  const observation = dossier.decompiler_completeness;
  assert.equal(observation?.status, "warnings");
  assert.ok(observation.warning_count > 0);
  assert.ok(
    observation.dropped_blocks.some(
      (block) => block.start !== null && block.end === null,
    ),
  );
  assert.match(dossier.pseudocode, /Removing unreachable block/u);
  assert.equal(observation.disassembly_available, true);
  assert.ok(
    evidence.limitations.some((text) =>
      text.includes("Removing unreachable block"),
    ),
  );
  assert.equal(evidence.subject?.digest.sha256, digest);
  assert.equal(
    createHash("sha256")
      .update(await readFile(target))
      .digest("hex"),
    digest,
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        provider: evidence.provider,
        source_sha256: digest,
        observation,
        source_unchanged: true,
        target_executed: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
