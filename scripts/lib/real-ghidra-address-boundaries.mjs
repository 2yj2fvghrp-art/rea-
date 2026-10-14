import { requireMcpToolError } from "./mcp-verifier-results.mjs";
import assert from "node:assert/strict";

/** Exercise segmented-address truncation through real CLI/MCP reads and edits. */
export async function verifyGhidraAddressBoundaries(client, entry, cli) {
  const query = async (name, args) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 240000 },
    );
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return reply.structuredContent.normalized_result;
  };
  const before = await query("analyze_function", { procedure: entry });
  // The segmented parser used to discard the high 32 bits and alias this entry.
  const overflow = (0x100000000n + BigInt(entry)).toString(16);
  const representations = [
    `0x${overflow}`,
    `0X${overflow}`,
    overflow,
    `ram:0x${overflow}`,
    `%72am:0x${overflow}`,
  ];
  for (const address of representations) {
    for (const [name, args] of [
      ["read_bytes", { address, length: 1 }],
      ["inspect_native_instruction", { address }],
      ["resolve_containing_procedure", { address }],
      ["procedure_info", { procedure: address }],
      [
        "annotate_native_function",
        {
          procedure: address,
          name: "MUST_NOT_ALIAS",
          comment: "MUST NOT WRITE",
        },
      ],
    ]) {
      const reply = await client.callTool(
        { name, arguments: args },
        { timeout: 240000 },
      );
      assert.equal(reply.isError, true, `${name} accepted ${address}`);
      const error = requireMcpToolError(reply);
      assert.equal(error?.code, "invalid_request", JSON.stringify(reply));
      assert.equal(error.details.operation, name);
      const issues = JSON.stringify(error.details.issues);
      assert.match(issues, /cannot be represented without truncation/u);
      assert.ok(issues.includes(address), issues);
      // A rejected request produces no Evidence; errors carry text only.
      assert.equal(reply.structuredContent, undefined);
    }
  }
  assert.deepEqual(
    await query("analyze_function", { procedure: entry }),
    before,
    "Rejected oversized annotations changed the aliased function",
  );
  // Leading zeros and an encoded explicit space preserve the requested offset.
  const padded = `%72am:0x0000${BigInt(entry).toString(16)}`;
  assert.deepEqual(
    await query("read_bytes", { address: padded, length: 1 }),
    await query("read_bytes", { address: entry, length: 1 }),
  );
  const aliasKeys = [entry, padded];
  const originalName = await query("address_name", { address: entry });
  assert.equal(typeof originalName, "string", "Entry has no restorable name");
  const failures = [];
  let restorationFailed = false;
  try {
    assert.deepEqual(
      await query("set_addresses_names", {
        names: {
          [entry]: "rea_same_address_alias",
          [padded]: "rea_same_address_alias",
        },
      }),
      Object.fromEntries(aliasKeys.map((address) => [address, true])),
      "Equivalent address spellings with one requested name share one edit",
    );
    assert.equal(
      await query("address_name", { address: entry }),
      "rea_same_address_alias",
    );
    assert.deepEqual(
      await query("set_addresses_names", {
        names: {
          [entry]: "rea_first_address_alias",
          [padded]: "rea_second_address_alias",
        },
      }),
      Object.fromEntries(aliasKeys.map((address) => [address, false])),
      "Conflicting spellings of one Ghidra address must be rejected together",
    );
    assert.equal(
      await query("address_name", { address: entry }),
      "rea_same_address_alias",
      "A rejected alias collision must leave the preexisting target name unchanged",
    );
  } catch (cause) {
    failures.push(cause);
  } finally {
    // Restore even when a failed reply leaves the write outcome uncertain.
    // The public API restores the observed name, not private symbol provenance.
    try {
      assert.equal(
        await query("set_address_name", { address: entry, name: originalName }),
        true,
        "Temporary address alias restoration was rejected",
      );
      assert.equal(
        await query("address_name", { address: entry }),
        originalName,
        "Temporary address alias restoration did not restore the observed name",
      );
    } catch (cause) {
      restorationFailed = true;
      failures.push(cause);
    }
  }
  if (restorationFailed)
    throw new AggregateError(
      failures,
      "Ghidra address boundary verification failed to restore its temporary name",
    );
  if (failures.length > 0) throw failures[0];
  for (const [command, flags, operation] of [
    ["read-bytes", ["--length", "1"], "read_bytes"],
    [
      "annotate-native-function",
      ["--name", "MUST_NOT_ALIAS"],
      "annotate_native_function",
    ],
  ]) {
    let failure;
    try {
      await cli(command, representations[0], flags);
    } catch (error) {
      assert.equal(error.code, 1);
      failure = JSON.parse(error.stdout);
    }
    assert.equal(failure?.code, "invalid_request");
    assert.equal(failure.details.operation, operation);
    assert.match(
      JSON.stringify(failure.details.issues),
      /cannot be represented without truncation/u,
    );
  }
}
