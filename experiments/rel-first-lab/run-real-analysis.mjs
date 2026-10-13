import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownReport, summarizeEvidence } from "./report.mjs";

// Run from the repository checkout and keep every generated file outside Git.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const lab = fileURLToPath(new URL("./", import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : null;
if (!output) {
  console.error("Usage: node experiments/rel-first-lab/run-real-analysis.mjs /absolute/output/dir");
  process.exit(2);
}
const relativeOutput = relative(repository, output);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput))) {
  console.error("Choose an output directory outside the REL repository checkout.");
  process.exit(2);
}
mkdirSync(output, { recursive: true });
const cli = join(repository, "scripts", "rea.mjs");
const built = join(repository, "dist", "cli-runtime", "cli.js");
if (!existsSync(built)) {
  console.error("REL analysis blocked: first run npm ci and npm run build:cached. No REA run attempted.");
  process.exit(2);
}
const run = (args, filename, timeout) => {
  const out = openSync(join(output, filename), "w");
  const err = openSync(join(output, `${filename}.stderr.txt`), "w");
  const started = performance.now();
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: repository,
      stdio: ["ignore", out, err],
      timeout,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const elapsedMs = Math.round(performance.now() - started);
  if (result.error || result.status !== 0) {
    throw new Error(`${filename} failed (status=${result.status}, signal=${result.signal ?? "none"}, duration=${elapsedMs}ms): ${result.error?.message ?? "see stderr artifact"}`);
  }
  return elapsedMs;
};
try {
  const verifyMs = run([join(lab, "verify.mjs")], "lab-verification.txt", 15000);
  const cliMs = run([join(lab, "cli.mjs"), "bridge"], "observed-search.txt", 15000);
  const evidenceMs = run([cli, "analyze-javascript-application", lab, "--json"], "evidence.json", 180000);
  const evidence = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
  const summary = summarizeEvidence(evidence);
  // Project a compact authenticated view from the complete Evidence as a second REA tool operation.
  writeFileSync(join(output, "summary-request.json"), JSON.stringify({ source: { kind: "inline", evidence }, view: { kind: "summary" } }));
  run([cli, "inspect-analysis-view", join(output, "summary-request.json"), "--json"], "view-evidence.json", 120000);
  const view = JSON.parse(readFileSync(join(output, "view-evidence.json"), "utf8"));
  if (view.error !== undefined || view.operation !== "inspect_analysis_view" || !view.normalized_result) {
    throw new Error("REA view projection did not produce valid Evidence; see view-evidence.json");
  }
  writeFileSync(join(output, "summary.json"), JSON.stringify({ ...summary, durations_ms: { sample_verify: verifyMs, sample_cli: cliMs, rea_static_analysis: evidenceMs } }, null, 2) + "\n");
  writeFileSync(join(output, "REL_EVIDENCE_REPORT.md"), markdownReport(summary));
  console.log(`REL REAL ANALYZER VERIFIED: ${summary.counts.nodes} graph nodes, ${summary.counts.edges} edges; Evidence ${summary.evidence_id}`);
  console.log(`Local output: ${output}`);
} catch (error) {
  console.error(`REL analysis incomplete: ${error.message}`);
  process.exitCode = 1;
}
