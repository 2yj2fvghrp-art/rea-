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
 * Find a string that IDA maps outside every function. A string inside a
 * function chunk (inline data in code) is valid and skipped, so the strings are
 * tried in order. Returns its address, or undefined when no string qualifies.
 */
export async function findMappedNonFunction(strings, resolveAt) {
  for (const { address } of strings) {
    const resolved = await resolveAt(address);
    if (!resolved.found && resolved.reason === "not_in_procedure")
      return address;
  }
  return undefined;
}
