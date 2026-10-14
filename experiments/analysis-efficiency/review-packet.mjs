import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { packetFacts, packetRequest } from "./packet-entry.mjs";

const { values } = parseArgs({
  options: {
    trial: { type: "string" },
    oracle: { type: "string" },
    "runtime-root": { type: "string" },
    selection: { type: "string" },
  },
});
if (
  !values.trial ||
  !values.oracle ||
  !values["runtime-root"] ||
  !["baseline", "focused", "discovery"].includes(values.selection)
)
  throw new Error(
    "Use --trial DIR --oracle JSON --runtime-root DIR --selection baseline|focused|discovery",
  );

const root = values["runtime-root"];
const { parseEvidence } = await import(
  pathToFileURL(resolve(root, "dist/domain/evidence.js")).href
);
const { inspectPacketCaptureInputSchema, packetCaptureSchema } = await import(
  pathToFileURL(resolve(root, "dist/domain/captures/packetCapture.js")).href
);
const { inspectPacketFieldsInputSchema, packetFieldsCatalogSchema } =
  await import(
    pathToFileURL(resolve(root, "dist/domain/captures/packetFields.js")).href
  );
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const settings = JSON.parse(
  await readFile(resolve(values.trial, "trial-settings.json"), "utf8"),
);
const summary = JSON.parse(
  await readFile(resolve(values.trial, "summary.json"), "utf8"),
);
const expected = Object.fromEntries(
  ["kind", "matching_packets", "rows"].map((key) => [key, oracle[key]]),
);
const calls = (await readFile(resolve(values.trial, "events.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "mcp_tool_call",
  )
  .map((event) => event.item);
const reasons = [];
let facts, answer, packetId;
try {
  if (oracle.kind !== "postgres")
    throw new Error("This model rubric is the fixed PostgreSQL question only");
  const expectedCalls =
    values.selection === "discovery"
      ? ["inspect_packet_fields", "inspect_packet_capture"]
      : ["inspect_packet_capture"];
  if (
    !isDeepStrictEqual(
      calls.map((call) => call.tool),
      expectedCalls,
    ) ||
    calls.some(
      (call) =>
        call.server !== "rea" || call.status !== "completed" || call.error,
    )
  )
    throw new Error(
      "Completed public REA call sequence differs from the fixed plan",
    );
  const ids = new Set();
  for (const call of calls) {
    const result = call.result;
    if (result?.isError)
      throw new Error("Tool failure is not observed packet evidence");
    const text = result?.content?.filter((item) => item.type === "text") ?? [];
    if (!result?.structuredContent && text.length !== 1)
      throw new Error("No unambiguous captured Evidence envelope");
    const evidence = result.structuredContent ?? JSON.parse(text[0].text);
    parseEvidence(evidence);
    if (ids.has(evidence.evidence_id))
      throw new Error("Duplicate reply identity");
    ids.add(evidence.evidence_id);
    if (call.tool === "inspect_packet_fields") {
      const input = inspectPacketFieldsInputSchema.parse({
        kind: "fields",
        protocol: "tcp",
        query: "tcp.flags",
        limit: 1,
      });
      const report = packetFieldsCatalogSchema.parse(
        evidence.normalized_result,
      );
      if (
        !isDeepStrictEqual(
          inspectPacketFieldsInputSchema.parse(call.arguments),
          input,
        ) ||
        !isDeepStrictEqual(evidence.parameters, input) ||
        !isDeepStrictEqual(report.selection, input) ||
        evidence.operation !== call.tool ||
        !report.records.some((row) => row.abbreviation === "tcp.flags") ||
        evidence.subject?.local_path !== report.tool.path ||
        evidence.subject?.digest?.sha256 !== report.tool.sha256
      )
        throw new Error(
          "Discovery Evidence does not establish the requested installed field",
        );
    } else {
      const input = inspectPacketCaptureInputSchema.parse(
        packetRequest(
          "wireshark-pgsql-jdbc.pcap",
          settings.selected_artifact_path,
          values.selection,
        ),
      );
      const report = packetCaptureSchema.parse(evidence.normalized_result);
      if (
        !isDeepStrictEqual(
          inspectPacketCaptureInputSchema.parse(call.arguments),
          input,
        ) ||
        !isDeepStrictEqual(evidence.parameters, input) ||
        !isDeepStrictEqual(report.selection, input) ||
        evidence.operation !== call.tool ||
        evidence.subject?.local_path !== input.path ||
        evidence.subject?.digest?.sha256 !== oracle.sha256 ||
        report.artifact.path !== input.path ||
        report.artifact.sha256 !== oracle.sha256
      )
        throw new Error(
          "Capture Evidence differs from the fixed input/byte identity",
        );
      facts = packetFacts("postgres", report);
      packetId = evidence.evidence_id;
    }
  }
  if (!isDeepStrictEqual(facts, expected))
    throw new Error("Observed facts differ from independent raw header oracle");
  answer = JSON.parse(
    (await readFile(resolve(values.trial, "answer.txt"), "utf8")).trim(),
  );
  if (
    !isDeepStrictEqual(
      Object.keys(answer).sort(),
      [
        "kind",
        "matching_packets",
        "rows",
        "evidence_ids",
        "limitations",
      ].sort(),
    ) ||
    !isDeepStrictEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [key, answer[key]]),
      ),
      expected,
    )
  )
    throw new Error("Final answer is not the exact requested recorded facts");
  if (
    !Array.isArray(answer.evidence_ids) ||
    !answer.evidence_ids.includes(packetId) ||
    answer.evidence_ids.some((id) => !ids.has(id)) ||
    new Set(answer.evidence_ids).size !== answer.evidence_ids.length
  )
    throw new Error("Final citations lack the authenticated packet Evidence");
  if (
    !Array.isArray(answer.limitations) ||
    answer.limitations.length === 0 ||
    answer.limitations.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error("Final answer omits investigation limitations");
  if (
    summary.exit_code !== 0 ||
    summary.timeout ||
    summary.selected_artifact_bytes_unchanged !== true ||
    settings.selected_artifact_sha256_before !== oracle.sha256 ||
    summary.selected_artifact_sha256_after !== oracle.sha256
  )
    throw new Error(
      "Trial did not complete with the selected artifact unchanged",
    );
} catch (error) {
  reasons.push(String(error));
}
const review = {
  factual_correctness: reasons.length ? "failed" : "passed",
  scope:
    "Fixed first-2000-frame PostgreSQL question; authenticated tool observations and independent raw header oracle",
  workflow_correctness: reasons.length ? "failed" : "passed",
  reasons,
  completed_calls: calls.length,
  wall_seconds: summary.wall_seconds,
  usage: summary.usage,
  selected_artifact_sha256: oracle.sha256,
  limitation_prose:
    "Presence checked; wording requires transcript review, not heuristic factual certification",
};
await writeFile(
  resolve(values.trial, "packet-review.json"),
  JSON.stringify(review, null, 2) + "\n",
);
console.log(JSON.stringify(review));
if (reasons.length) process.exitCode = 1;
