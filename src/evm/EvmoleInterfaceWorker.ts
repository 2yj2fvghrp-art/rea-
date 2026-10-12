import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { evmCompilerSelection } from "../domain/evm/evmInterface.js";
import type { SolcArtifact } from "../domain/evm/solcArtifact.js";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";
import { selectSolcArtifact } from "./SolcArtifactSelection.js";
import { evmWorkerRequestSchema } from "./EvmInterfaceWorkerContract.js";
import { projectEvmoleInterface } from "./EvmoleInterfaceAdapter.js";
import { inspectSolidityMetadata } from "./SolidityMetadata.js";
import {
  EVM_INTERFACE_LIMITS,
  EVM_FILE_SIZE_FAILURE_EXIT,
} from "./EvmoleRelease.js";

class UnsupportedContainer extends Error {}

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined)
    throw new Error("Owned worker request path missing.");
  const request = evmWorkerRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: unknown;
  let compilerFailureContext:
    | {
        compiler_diagnostics: SolcArtifact["diagnostics"];
        carrier_sha256: string;
      }
    | undefined;
  try {
    const carrier = await readFile(request.snapshot_path);
    const compilerSelection = evmCompilerSelection(request.encoding);
    const selected =
      compilerSelection === undefined
        ? null
        : selectSolcArtifact(carrier, compilerSelection);
    if (selected !== null && !selected.ok) {
      reply = {
        ok: false,
        reason: selected.error.reason,
        message: selected.error.message,
        ...(selected.error.compiler_diagnostics === undefined
          ? {}
          : {
              compiler_diagnostics: selected.error.compiler_diagnostics,
              carrier_sha256: createHash("sha256")
                .update(carrier)
                .digest("hex"),
            }),
      };
    } else {
      const compilerArtifact = selected?.ok
        ? selected.value.artifact
        : undefined;
      if (compilerArtifact !== undefined)
        compilerFailureContext = {
          compiler_diagnostics: compilerArtifact.diagnostics,
          carrier_sha256: createHash("sha256").update(carrier).digest("hex"),
        };
      let bytes: Uint8Array | null;
      if (selected?.ok) bytes = selected.value.bytes;
      else if (typeof request.encoding === "string")
        bytes = decodeEvmBytecodeCarrier(carrier, request.encoding);
      else
        throw new Error("Compiler encoding has no parsed compiler selection.");
      const compilerFacts =
        compilerArtifact === undefined
          ? {}
          : {
              compiler_artifact: compilerArtifact,
              carrier_sha256: createHash("sha256")
                .update(carrier)
                .digest("hex"),
            };
      if (bytes === null) {
        reply = {
          ok: true,
          version: "0.9.3",
          bytecode: {
            sha256: null,
            bytes:
              compilerArtifact?.object === null ||
              compilerArtifact === undefined
                ? null
                : compilerArtifact.object.length / 2,
            hex: null,
            metadata: null,
          },
          raw: null,
          ...compilerFacts,
        };
      } else {
        if (bytes[0] === 0xef && bytes[1] === 0x00)
          throw new UnsupportedContainer(
            "Container marker EF00 is outside the verified flat-bytecode interface profile.",
          );
        const modulePath = import.meta.resolve("evmole/no_tla");
        const metadata = z
          .object({ version: z.literal("0.9.3") })
          .parse(
            JSON.parse(
              await readFile(new URL("../package.json", modulePath), "utf8"),
            ),
          );
        const engine = await import("evmole/no_tla");
        engine.initSync({
          module: await readFile(
            new URL(import.meta.resolve("evmole/evmole_bg.wasm")),
          ),
        });
        const inferred = projectEvmoleInterface(
          engine.contractInfo(Buffer.from(bytes).toString("hex"), {
            selectors: true,
            arguments: true,
            stateMutability: true,
          }),
        );
        reply = {
          ok: true,
          version: metadata.version,
          bytecode: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            hex: Buffer.from(bytes).toString("hex"),
            metadata: inspectSolidityMetadata(bytes),
          },
          raw: inferred.raw,
          ...compilerFacts,
        };
      }
    }
  } catch (cause: unknown) {
    reply = {
      ok: false,
      reason:
        cause instanceof EvmCarrierFailure
          ? "format"
          : cause instanceof UnsupportedContainer
            ? "unsupported"
            : "decoder",
      message: cause instanceof Error ? cause.message : String(cause),
      ...compilerFailureContext,
    };
  }
  let encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) > EVM_INTERFACE_LIMITS.outputBytes)
    encoded = JSON.stringify({
      ok: false,
      reason: "output-limit",
      message: "Complete interface evidence exceeds the 16 MiB reply budget.",
    });
  try {
    await writeFile(request.reply_path, encoded, { flag: "wx", mode: 0o600 });
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "EFBIG") {
      try {
        await writeFile(request.failure_marker_path, "F", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (markerFailure: unknown) {
        process.stderr.write(
          `File-size failure marker unavailable: ${markerFailure instanceof Error ? markerFailure.message : String(markerFailure)}\n`,
        );
      }
      process.exitCode = EVM_FILE_SIZE_FAILURE_EXIT;
    } else throw cause;
  }
};

await main();
