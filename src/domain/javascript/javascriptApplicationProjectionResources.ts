import type { JavaScriptModuleSemanticIr } from "./javascriptModuleSemanticIr.js";
import { partialApplicationCoverage } from "./javascriptApplicationEvidenceSchemas.js";
import { projectJavaScriptExportReturnShapes } from "./javascriptExportReturnShapeProjection.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";

/** Forecast static-fact expansion into observations, nodes and relationships. */
export const estimateJavaScriptStaticApplicationProjection = (
  facts: JavaScriptStaticAnalysis,
  checkpointBytes: number,
  sourcePath: string,
): number => {
  // A finding can produce a node, a separate observation and several edges.
  // Allow for identifiers, locations, authority, coverage and schema copies,
  // independently of the producer's compact checkpoint representation.
  const findings =
    facts.references.length +
    facts.endpoints.length +
    facts.storage.length +
    facts.role_paths.length +
    facts.source_map_urls.length +
    facts.electron.browser_windows.length +
    facts.electron.context_bridge_apis.length +
    facts.electron.ipc.length +
    facts.electron.sender_validations.length +
    facts.electron.utility_processes.length +
    facts.electron.native_addon_bindings.length;
  let records = findings * 8;
  let repeatedBytes = 0;
  for (const registration of facts.bundler_registrations) {
    records +=
      3 +
      registration.modules.length * 3 +
      registration.entry_module_keys.length * 3 +
      registration.async_chunk_keys.length * 3;
    // Every module observation and containment edge repeats its chunk keys.
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(registration.chunk_keys)) *
      registration.modules.length *
      2;
  }
  for (const binding of facts.electron.native_addon_bindings)
    records += binding.members.length * 3;
  for (const path of facts.electron.call_paths ?? []) {
    // One contextual node and edge per step, with repeated guards and identity.
    records += path.steps.length * 4 + 8;
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(path.conditions)) *
      path.steps.length *
      2;
  }
  const metadataBytes = 2048 + Buffer.byteLength(sourcePath) * 4;
  // Measured on a complete Grok Bot app.asar analysis: the sum of these
  // forecasts was 89 MB for 73 MB of retained application-graph objects.
  return checkpointBytes * 4 + repeatedBytes + records * metadataBytes;
};

/** Reserve exported observations and repeated return shapes before graph projection. */
export const estimateJavaScriptModuleApplicationProjection = (
  module: JavaScriptModuleSemanticIr,
  sourcePath: string,
): number => {
  const shapeBytesByCallable = new Map<
    string,
    { bytes: number; nameBytes: number }
  >();
  let bytes = 0;
  for (const link of module.moduleLinks) {
    // Include source/export observations, identity and their containment/import edges.
    bytes += 8 * (2048 + Buffer.byteLength(sourcePath) * 4);
    bytes += Buffer.byteLength(JSON.stringify(link)) * 4;
    if (link.callableId === null || link.exportedName === null) continue;
    const nameBytes = Buffer.byteLength(JSON.stringify(link.exportedName));
    let measured = shapeBytesByCallable.get(link.callableId);
    if (measured === undefined) {
      const shapes = projectJavaScriptExportReturnShapes({
        ir: module,
        link,
        modulePath: sourcePath,
        baseCoverage: partialApplicationCoverage([], null),
      });
      measured = {
        bytes: shapes === null ? 0 : Buffer.byteLength(JSON.stringify(shapes)),
        nameBytes,
      };
      shapeBytesByCallable.set(link.callableId, measured);
    }
    // Flattened paths can expand quadratically relative to nested IR. Measure
    // the owning projection, rather than multiplying the unflattened callable.
    bytes += Math.max(0, measured.bytes + nameBytes - measured.nameBytes) * 4;
  }
  return bytes;
};
