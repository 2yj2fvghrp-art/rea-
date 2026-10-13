import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/** This is a presentation of REA Evidence, NOT an independent validation of its digest. */
export function summarizeEvidence(record) {
  if (!isObject(record)) throw new Error("Expected a JSON Evidence record");
  if (record.error !== undefined) throw new Error(`REA returned an error: ${String(record.error)}`);
  if (record.operation !== "analyze_javascript_application") {
    throw new Error(`Unexpected Evidence operation: ${String(record.operation)}`);
  }
  const result = record.normalized_result;
  if (!isObject(result) || !isObject(result.graph) || !isObject(result.semantic_graph)) {
    throw new Error("Missing REA application or semantic graph; do not report success");
  }
  const graph = result.graph;
  const semantic = result.semantic_graph;
  if (!text(record.evidence_id) || !text(graph.graph_id) || !text(result.root_artifact_sha256)) {
    throw new Error("Missing Evidence/graph/artifact identifier");
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("Graph nodes/edges unavailable");
  }
  if (semantic.application_graph_id !== graph.graph_id) {
    throw new Error("Semantic graph is not bound to application graph");
  }
  if (semantic.root_artifact_sha256 !== result.root_artifact_sha256) {
    throw new Error("Semantic graph does not match source artifact");
  }
  const statistics = isObject(result.statistics) ? result.statistics : {};
  const byKind = {};
  for (const node of graph.nodes) {
    const kind = text(node.kind) ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const relationships = {};
  for (const edge of graph.edges) {
    const relation = text(edge.relation) ?? "unknown";
    relationships[relation] = (relationships[relation] ?? 0) + 1;
  }
  const seenLimitations = [record.limitations, result.limitations, graph.limitations]
    .filter(Array.isArray).flat().filter((v) => typeof v === "string");
  return {
    status: "analyzer-evidence-present",
    operation: record.operation,
    evidence_id: record.evidence_id,
    provider: text(record.provider?.id),
    artifact_sha256: result.root_artifact_sha256,
    application_graph_id: graph.graph_id,
    semantic_graph_id: text(semantic.graph_id),
    graph_coverage: graph.coverage ?? null,
    semantic_coverage: semantic.coverage ?? null,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      modules: integer(statistics.modules),
      files_parsed: integer(statistics.parsed_javascript_files),
      parse_failures: integer(statistics.parse_failures),
    },
    node_kinds: byKind,
    relationships,
    limitations: [...new Set(seenLimitations)].slice(0, 20),
  };
}

const safeInline = (value) => String(value).replaceAll("`", "'").replaceAll("\n", " ");
export function markdownReport(summary) {
  const lines = [
    "# REL — first real analyzer run",
    "",
    "**Status:** REA produced a JavaScript application Evidence record for the fork-owned lab.",
    "",
    "## What the analyzer actually returned",
    "",
    `- Evidence ID: \`${safeInline(summary.evidence_id)}\``,
    `- Input artifact SHA-256: \`${safeInline(summary.artifact_sha256)}\``,
    `- Application graph ID: \`${safeInline(summary.application_graph_id)}\``,
    `- Modules in statistics: ${summary.counts.modules ?? "not provided"}`,
    `- Files parsed: ${summary.counts.files_parsed ?? "not provided"}`,
    `- Parse failures: ${summary.counts.parse_failures ?? "not provided"}`,
    `- Graph nodes / edges: ${summary.counts.nodes} / ${summary.counts.edges}`,
    `- Graph coverage (raw): \`${safeInline(JSON.stringify(summary.graph_coverage))}\``,
    "",
    "**Observed relationship types (static graph; not runtime proof):**",
    ...Object.entries(summary.relationships).sort(([a],[b])=>a.localeCompare(b)).map(([type,count])=>`- ${safeInline(type)}: ${count}`),
    "",
    "## Learning checkpoint",
    "",
    "The toy CLI's output is established separately by `verify.mjs`. The sample source states that exact title matches outrank prefixes, substrings, and tags. REA's graph describes *static* structure; it does not by itself prove which ranking branches executed during a search.",
    "",
    "## Unknowns / limitations",
    "",
    ...((summary.limitations.length ? summary.limitations : ["No explicit limitations surfaced in these fields; absence does not prove completeness."]).map(x=>`- ${safeInline(x)}`)),
    "- No independent digest re-computation or full reconstruction-equivalence test was performed by this report script.",
    "- The graph is evidence of a single local sample, not evidence that the engine can reverse engineer every application.",
    "",
    "**Next question:** Can the saved Evidence trace `cli.mjs` importing `search.mjs` and `notes.mjs`, with exact source locations?",
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error("Usage: node report.mjs evidence.json summary.json report.md");
    const record = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const summary = summarizeEvidence(record);
    writeFileSync(process.argv[3], `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(process.argv[4], markdownReport(summary));
    console.log(`REL Evidence: ${summary.counts.nodes} nodes, ${summary.counts.edges} edges; ${summary.evidence_id}`);
  } catch (error) {
    console.error(`REL report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
