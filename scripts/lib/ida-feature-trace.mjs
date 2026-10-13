import assert from "node:assert/strict";

/**
 * Assert the `trace_feature` result of the real IDA lane for one selected
 * procedure: its procedure match is present and its references are contained.
 */
export function assertFeatureTrace(trace, procedure) {
  assert.ok(
    trace.matches.some(
      ({ type, address }) =>
        type === "procedure" && address === procedure.address,
    ),
  );
  assert.equal(typeof trace.truncated, "boolean");
  for (const reference of trace.references) {
    assert.equal(reference.target_address, procedure.address);
    assert.equal(reference.containing_procedure.found, true);
  }
}
