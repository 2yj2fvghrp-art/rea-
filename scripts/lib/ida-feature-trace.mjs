import assert from "node:assert/strict";

const NEGATIVE_REASONS = new Set(["not_in_procedure", "outside_segments"]);

/**
 * Assert the `trace_feature` result of the real IDA lane for one selected
 * procedure. The query is a substring search, so the trace may also match other
 * procedures and strings; each reference is checked against its own matched
 * target, and a source outside every function (a data reference) is valid.
 */
export function assertFeatureTrace(trace, procedure) {
  assert.ok(
    trace.matches.some(
      ({ type, address }) =>
        type === "procedure" && address === procedure.address,
    ),
    "The trace omitted the selected procedure's match.",
  );
  assert.equal(typeof trace.truncated, "boolean");
  const matched = new Set(trace.matches.map(({ address }) => address));
  for (const reference of trace.references) {
    assert.ok(
      matched.has(reference.target_address),
      `A reference targets ${reference.target_address}, which is not a match.`,
    );
    const { containing_procedure: containing } = reference;
    if (containing.found)
      assert.equal(typeof containing.procedure.address, "string");
    else assert.ok(NEGATIVE_REASONS.has(containing.reason));
  }
}

/**
 * Find a string that IDA maps outside every function. Returns its address, or
 * undefined when the target has no strings.
 */
export async function findMappedNonFunction(strings, resolveAt) {
  if (strings.length === 0) return undefined;
  const mapped = await resolveAt(strings[0].address);
  assert.equal(mapped.found, false);
  assert.equal(mapped.reason, "not_in_procedure");
  return strings[0].address;
}
