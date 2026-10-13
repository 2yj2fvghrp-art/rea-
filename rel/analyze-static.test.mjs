import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { investigationReport, planStaticAnalysis, repository } from "./analyze-static.mjs";

const home = mkdtempSync(join(tmpdir(), "rel-generic-test-"));
const fixture = join(home, "owned-fixture");
mkdirSync(fixture);
writeFileSync(join(fixture, "example.mjs"), "export const answer = 42;\n");
const sourceFile = join(fixture, "example.mjs");
const webCapture = join(home, "test.har");
writeFileSync(webCapture, "{}");
const cli = fileURLToPath(new URL("../rel.mjs", import.meta.url));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

test("authorization must be explicit even for a source-owned fixture", () => {
  assert.throws(() => planStaticAnalysis(fixture, join(home, "output"), false), /--authorized/);
});

test("regular JavaScript source file is not an extracted application", () => {
  assert.throws(() => planStaticAnalysis(sourceFile, join(home, "output"), true), /directory or ASAR/);
});

test("the beginner command does not run websites or unknown file formats", () => {
  assert.throws(() => planStaticAnalysis("https://example.org", join(home, "output"), true), /static JavaScript/);
  assert.throws(() => planStaticAnalysis(webCapture, join(home, "output"), true), /static JavaScript/);
});

test("output may not be placed in the target, nor contain the target", () => {
  assert.throws(() => planStaticAnalysis(fixture, join(fixture, "evidence"), true), /outside/);
  assert.throws(() => planStaticAnalysis(fixture, home, true), /outside/);
});

test("output may not be placed inside the REL repository", () => {
  assert.throws(() => planStaticAnalysis(fixture, join(repository, "evidence"), true), /outside/);
});

test("existing output is not overwritten", () => {
  const prior = join(home, "prior");
  mkdirSync(prior);
  assert.throws(() => planStaticAnalysis(fixture, prior, true), /already exists/);
});

test("symlinked targets are rejected before analysis", () => {
  const link = join(home, "linked");
  symlinkSync(fixture, link);
  assert.throws(() => planStaticAnalysis(link, join(home, "output"), true), /Symbolic/);
});

test("valid static analysis gets an exact canonical plan after build", () => {
  const plan = planStaticAnalysis(fixture, join(home, "fresh-results"), true);
  assert.equal(plan.format, "directory");
  assert.equal(plan.target, fixture);
  assert.equal(plan.output, join(home, "fresh-results"));
});

test("plain-English report does not confuse static data with runtime proof", () => {
  const record = {
    input_path: fixture, question: "How is a search implemented?",
    evidence_id: "ev_local", artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_local", provider: "rea-js",
    graph_coverage: { status: "partial" }, semantic_coverage: { status: "unknown" },
    counts: { nodes: 4, edges: 1, files_parsed: 1, parse_failures: 0 },
    relationships: { imports: 1 }, node_kinds: { module: 2 }, limitations: ["Source maps unavailable"],
  };
  const report = investigationReport(record);
  assert.match(report, /Question:\*\* How is a search implemented/);
  assert.match(report, /unknown/);
  assert.match(report, /does not prove runtime behavior/);
  assert.match(report, /Source maps unavailable/);
});

test("Codex status command is informational and has no configuration side effects", () => {
  const output = execFileSync(process.execPath, [cli, "codex"], { encoding: "utf8" });
  assert.match(output, /Codex workspace configuration/);
  assert.match(output, /Only this REL fork/);
});

test("arbitrary analysis without authorization is refused", () => {
  assert.throws(
    () => execFileSync(process.execPath, [cli, "analyze", fixture, "--out", join(home, "blocked")], { stdio: "pipe", encoding: "utf8" }),
    /--authorized/,
  );
});
