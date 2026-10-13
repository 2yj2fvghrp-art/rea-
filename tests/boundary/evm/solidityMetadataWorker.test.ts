import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { solidityMetadataSchema } from "../../../src/domain/evm/solidityMetadata.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** Real compiled worker and unchanged WASM engine; no Linux provider-admission claim. */
it.each([
  ["compiler", "00a164736f6c634300081e000a", "decoded"],
  ["integer", "00a1011bffffffffffffffff000b", "decoded"],
  ["unsupported tag", "00a16178c0000005", "not-decoded"],
])(
  "retains independent %s metadata through the actual worker",
  async (kind, hex, status) => {
    const directory = await createTestTempDirectory("rea-solidity-worker-");
    const snapshot = join(directory, "selected.hex");
    const reply = join(directory, "reply.json");
    const request = join(directory, "request.json");
    await writeFile(snapshot, hex);
    await writeFile(
      request,
      JSON.stringify({
        snapshot_path: snapshot,
        reply_path: reply,
        failure_marker_path: join(directory, "resource.failure"),
        encoding: "hex",
      }),
    );
    await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--disable-wasm-trap-handler",
        new URL("../../../dist/evm/EvmoleInterfaceWorker.js", import.meta.url)
          .pathname,
        request,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const value = JSON.parse(await readFile(reply, "utf8"));
    expect(value.ok, JSON.stringify(value)).toBe(true);
    expect(value.bytecode.hex).toBe(hex);
    const metadata = solidityMetadataSchema.parse(value.bytecode.metadata);
    expect(metadata.status).toBe(status);
    if (kind === "integer")
      expect(metadata.entries[0]?.value).toEqual({
        kind: "integer",
        value: "18446744073709551615",
      });
    if (kind === "compiler")
      expect(metadata.compiler_version?.value).toBe("0.8.30");
  },
);
