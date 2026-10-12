import { z } from "incur";
import { javaScriptAnalysisResourceControlsSchema } from "./domain/javascript/javascriptAnalysisResourceControls.js";
import { javaScriptSourcePathsSchema } from "./domain/javascript/javascriptSourceSelection.js";

/** Accept an agent-selected browser observation duration without an artificial ceiling. */
export const observationDuration = (fallback: number, minimum = 0) =>
  z
    .number()
    .int()
    .min(minimum)
    .default(fallback)
    .describe("Observation duration in milliseconds");

/** Shared passive browser origin options. */
export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional exact-origin filter"),
};

/** Opt-in HAR network evidence for observe-web-session; any content flag enables it. */
export const sessionNetworkOptions = {
  network: z
    .boolean()
    .default(false)
    .describe("Record in-scope network traffic as a HAR 1.2 log"),
  requestBodies: z
    .boolean()
    .default(false)
    .describe("Retain request bodies reported with each request"),
  responseBodies: z
    .enum(["none", "json", "all"])
    .default("none")
    .describe("Read completed response bodies: none, json or all"),
  headerValues: z
    .boolean()
    .default(false)
    .describe("Retain headers other than transport credentials"),
  websocketPayloads: z
    .boolean()
    .default(false)
    .describe("Retain WebSocket frame payloads"),
  sensitiveValue: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal value replaced in every retained URL, header, body, payload and timeline field; repeat as needed",
    ),
  sensitiveQueryParameter: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Query parameter name whose values in retained URL query strings, not fragments, are replaced everywhere; repeat as needed",
    ),
};

export const browserPageInspectionOptions = z.object({
  ...browserScopeOptions,
  observationMs: observationDuration(500),
  includeAccessibilityText: z
    .boolean()
    .default(false)
    .describe("Include accessibility text"),
  includeConsoleText: z
    .boolean()
    .default(false)
    .describe("Include console message text"),
  includeJsonBodyShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of JSON response bodies"),
  includeWebsocketShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of WebSocket payloads"),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include JavaScript source text"),
  includeStorageKeys: z
    .boolean()
    .default(false)
    .describe("Include storage key names without values"),
  includeStorageFingerprints: z
    .boolean()
    .default(false)
    .describe("Include content-derived storage fingerprints"),
});

export const electronPageInspectionOptions = z.object({
  observationMs: observationDuration(100),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include JavaScript source text"),
});

export const javascriptApplicationOptions = z.object({
  maxSemanticNodes:
    javaScriptAnalysisResourceControlsSchema.shape.max_semantic_nodes,
  maxSemanticNodesPerFile:
    javaScriptAnalysisResourceControlsSchema.shape.max_semantic_nodes_per_file,
  sourcePath: javaScriptSourcePathsSchema
    .optional()
    .describe(
      "Exact inventoried file path relative to the application root; repeat to select several. No implicit dependencies.",
    ),
  maxHeapMb: javaScriptAnalysisResourceControlsSchema.shape.max_heap_mb,
  analysisTimeoutMs:
    javaScriptAnalysisResourceControlsSchema.shape.analysis_timeout_ms,
  artifactFormat: z
    .enum(["auto", "asar", "directory"])
    .default("auto")
    .describe("Application artifact format"),
  integrityPolicy: z
    .enum(["fail", "record-and-continue"])
    .default("fail")
    .describe("Behavior when declared application integrity does not match"),
});
