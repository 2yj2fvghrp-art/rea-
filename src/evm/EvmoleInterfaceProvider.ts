import { createHash, randomUUID } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { EvmInterfacePort } from "../application/evm/EvmInterfacePort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type {
  AnalysisError,
  AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { InspectEvmInterfaceInput } from "../domain/evm/evmInterface.js";
import {
  evmInterfaceSchema,
  evmEncodingKind,
  evmCompilerSelection,
} from "../domain/evm/evmInterface.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  evmInterfaceFailure,
  capturedEvmOutput,
  type EvmFileSizeFailureEvidence,
} from "./EvmoleFailures.js";
import { projectEvmoleInterface } from "./EvmoleInterfaceAdapter.js";
import {
  EVMOLE_PROVIDER_IDENTITY,
  EVM_INTERFACE_LIMITS,
  EVM_FILE_SIZE_FAILURE_EXIT,
} from "./EvmoleRelease.js";
import { evmWorkerReplySchema } from "./EvmInterfaceWorkerContract.js";
import { decodeEvmBytecodeCarrier } from "./EvmBytecodeCarrier.js";
import {
  selectEvmWorkerLimits,
  type EvmWorkerLimits,
} from "./EvmWorkerLimits.js";

const OPERATION = "inspect_evm_interface";
const HOST_REQUIREMENT =
  "Initial real-verified offline EVM interface profile supports Linux x64 only.";
const replySchema = evmWorkerReplySchema;
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Run unchanged EVMole/WASM in an owned worker; no target, chain or network execution. */
export class EvmoleInterfaceProvider implements EvmInterfacePort {
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup:
    | {
        root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
        process: ProviderProcessSupervisor | undefined;
      }
    | undefined;

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-evm-interface-" }),
  ) {}

  /** Bind recovered interface candidates to both original carrier and decoded byte identity. */
  inspect(
    input: InspectEvmInterfaceInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing) return Promise.resolve(err(this.#closedError()));
    const operation = this.#tail.then(() =>
      this.#closing ? err(this.#closedError()) : this.#inspect(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #inspect(
    input: InspectEvmInterfaceInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const encoding = evmEncodingKind(input.encoding);
    const compilerSelection = evmCompilerSelection(input.encoding);
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase: "configuration" | "artifact-read" | "worker" = "configuration";
    let workerLimits: EvmWorkerLimits | undefined;
    const limiter =
      this.environment.REA_EVM_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          HOST_REQUIREMENT,
          { userMessage: HOST_REQUIREMENT },
        );
      try {
        if (!isAbsolute(limiter))
          throw new Error(
            "REA_EVM_PRLIMIT_COMMAND must be an absolute executable path.",
          );
        await access(limiter, constants.X_OK);
        if (!(await stat(limiter)).isFile())
          throw new Error(
            "Configured prlimit must be a regular executable file, not a directory.",
          );
      } catch (cause: unknown) {
        const reason = `Offline EVM interface inspection requires caller-supplied util-linux prlimit: ${limiter}; ${cause instanceof Error ? cause.message : String(cause)}`;
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          { cause, userMessage: reason },
        );
      }
      let inheritedLimits: string;
      try {
        inheritedLimits = await readFile("/proc/self/limits", "utf8");
      } catch (cause: unknown) {
        const reason = `Could not read inherited Linux resource limits at /proc/self/limits: ${cause instanceof Error ? cause.message : String(cause)}`;
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          { cause, userMessage: reason },
        );
      }
      const limits = selectEvmWorkerLimits(inheritedLimits);
      if (!limits.ok)
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          limits.error,
          { userMessage: limits.error },
        );
      workerLimits = limits.value;
      phase = "artifact-read";
      const carrier = await readStableArtifact(
        input.path,
        EVM_INTERFACE_LIMITS.inputBytes,
        options?.signal,
      );
      phase = "worker";
      root = await this.createRuntime();
      const snapshotPath = join(root.path, "carrier.snapshot");
      const requestPath = join(root.path, "request.json");
      const replyPath = join(root.path, "reply.json");
      await writeFile(snapshotPath, carrier.bytes, {
        flag: "wx",
        mode: 0o600,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          failure_marker_path: join(root.path, "resource.failure"),
          encoding: input.encoding,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const { NODE_OPTIONS: _ambientNodeOptions, ...environment } =
        this.environment;
      const execution = await runOwnedCommand(
        {
          command: limiter,
          arguments: [
            `--as=${String(workerLimits.addressSpaceBytes)}:`,
            `--fsize=${String(workerLimits.fileSizeBytes)}:`,
            "--core=0:",
            `--cpu=${String(workerLimits.cpuSeconds)}:`,
            "--",
            process.execPath,
            "--max-old-space-size=256",
            "--v8-pool-size=1",
            "--disable-wasm-trap-handler",
            fileURLToPath(
              new URL("./EvmoleInterfaceWorker.js", import.meta.url),
            ),
            requestPath,
          ],
          cwd: root.path,
          expectedCommand: null,
          runId: `rea-evm-interface-${randomUUID()}`,
          hostEnvironment: environment,
        },
        {
          timeoutMs: EVM_INTERFACE_LIMITS.timeoutMs,
          diagnosticBytes: EVM_INTERFACE_LIMITS.diagnosticBytes,
        },
        {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        },
      );
      const capturedOutput = capturedEvmOutput(execution);
      retainedOutput = capturedOutput;
      let reply: z.output<typeof replySchema>;
      try {
        const file = await readStableArtifact(
          replyPath,
          EVM_INTERFACE_LIMITS.outputBytes,
          options?.signal,
        );
        reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, { capturedOutput });
        throw new AnalysisOutputError(
          OPERATION,
          `Owned interface worker reply failed for ${input.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause, capturedOutput },
        );
      }
      if (!reply.ok) {
        if (
          reply.compiler_diagnostics !== undefined &&
          (compilerSelection === undefined ||
            reply.carrier_sha256 !== carrier.sha256)
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Compiler failure diagnostics do not bind to the selected carrier.",
            { capturedOutput },
          );
        const diagnostics =
          compilerSelection === undefined
            ? undefined
            : {
                carrier_path: input.path,
                carrier_sha256: carrier.sha256,
                carrier_bytes: carrier.bytes.length,
                compiler_selection: compilerSelection,
                ...(reply.compiler_diagnostics === undefined
                  ? {}
                  : { compiler_diagnostics: reply.compiler_diagnostics }),
              };
        if (reply.reason === "unsupported")
          throw new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            reply.message,
            { capturedOutput, diagnostics },
          );
        if (reply.reason === "resource")
          throw new AnalysisResourceConstraintError(
            OPERATION,
            "capacity",
            reply.message,
            null,
            { capturedOutput, diagnostics },
          );
        if (reply.reason === "format" || reply.reason === "selection")
          throw new AnalysisInputError(
            OPERATION,
            { capturedOutput, diagnostics },
            [
              {
                path: reply.reason === "selection" ? ["encoding"] : ["path"],
                reason:
                  reply.reason === "selection"
                    ? "invalid_value"
                    : "invalid_format",
                message: reply.message,
              },
            ],
          );
        if (reply.reason === "output-limit")
          throw new AnalysisOutputError(OPERATION, reply.message, {
            capturedOutput,
          });
        throw new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            ...diagnostics,
            stdout: execution.stdout.text,
            stderr: execution.stderr.text,
            captured_output: { ...capturedOutput },
          },
        });
      }
      const compilerArtifact = reply.compiler_artifact;
      if (compilerSelection !== undefined) {
        if (
          compilerArtifact === undefined ||
          reply.carrier_sha256 !== carrier.sha256 ||
          compilerArtifact.selection.source_unit !==
            compilerSelection.source_unit ||
          compilerArtifact.selection.contract_name !==
            compilerSelection.contract_name ||
          compilerArtifact.selection.bytecode_kind !==
            compilerSelection.bytecode_kind ||
          (compilerArtifact.status === "concrete"
            ? compilerArtifact.object?.toLowerCase() !== reply.bytecode.hex ||
              reply.raw === null
            : reply.raw !== null)
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Compiler worker changed the selected carrier or exact compiler selection.",
            { capturedOutput },
          );
      } else {
        if (typeof input.encoding !== "string")
          throw new AnalysisOutputError(
            OPERATION,
            "Compiler encoding has no parsed compiler selection.",
            { capturedOutput },
          );
        const selectedBytes = decodeEvmBytecodeCarrier(
          carrier.bytes,
          input.encoding,
        );
        if (
          compilerArtifact !== undefined ||
          reply.raw === null ||
          Buffer.from(selectedBytes).toString("hex") !== reply.bytecode.hex
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Decoded bytecode does not match the selected raw/hex carrier.",
            { capturedOutput },
          );
      }
      if (
        reply.bytecode.hex !== null &&
        (createHash("sha256")
          .update(Buffer.from(reply.bytecode.hex, "hex"))
          .digest("hex") !== reply.bytecode.sha256 ||
          reply.bytecode.hex.length / 2 !== reply.bytecode.bytes)
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Decoded byte identity does not match reported bytecode.",
          { capturedOutput },
        );
      const limitations = [
        `Configured worker resource soft limits: address_space_bytes=${String(workerLimits.addressSpaceBytes)}, cpu_seconds=${String(workerLimits.cpuSeconds)}, file_size_bytes=${String(workerLimits.fileSizeBytes)}. Selected from inherited tighter limits; original hard limits are retained. Effective worker limits are not independently probed.`,
        "Upstream may also report terminal metadata while recovering selectors. Its reported values are retained in raw_result, but integer precision and non-text-key coverage are unknown in the JS binding; complete original bytecode remains available.",
        "Recovered selectors, argument strings and mutability are upstream inferences, not verified ABI signatures or names. Empty results do not prove the absence of callable dispatch.",
        compilerArtifact === undefined
          ? "Bytecode kind, hardfork and deployed-contract authenticity are unknown. This inspection performs no target runtime execution, chain/RPC lookup or network request."
          : "Creation/deployed kind and compiler metadata are recorded compiler-artifact facts, not authenticated compilation or deployment evidence. Hardfork and deployed-contract authenticity remain unknown. No compiler, source acquisition, chain/RPC lookup or target runtime execution is performed.",
        "Original carrier and decoded bytecode SHA-256 are distinct identities; SHA-256 is not the Ethereum Keccak code hash.",
        "The owned worker has a 256 MiB JavaScript heap, 3 GiB virtual address-space limit and 30-second deadline. Virtual address space is distinct from resident memory; limits fail without partial success.",
      ];
      if (compilerArtifact !== undefined) {
        if (compilerArtifact.status !== "concrete")
          limitations.push(
            "Interface inference is unavailable because the selected compiler object is absent or contains unresolved library placeholders. Decoded hex and byte digest are unavailable; no addresses were substituted.",
          );
        if (
          compilerArtifact.link_references === null ||
          compilerArtifact.immutable_references === null
        )
          limitations.push(
            "Omitted compiler link/immutable reference facets were not supplied; missing facets do not establish absence of references.",
          );
        if (compilerArtifact.reference_bounds === "unavailable")
          limitations.push(
            "Selected compiler bytecode is absent; recorded reference spans are retained but their byte bounds cannot be verified.",
          );
        if (compilerArtifact.metadata.parse_status !== "valid")
          limitations.push(
            "Recorded selected-contract metadata is absent, malformed or resource-limited; compiler version and settings are unavailable.",
          );
        if (compilerArtifact.diagnostics === null)
          limitations.push(
            "Compiler diagnostics were not supplied; their absence does not establish successful compilation.",
          );
      }
      const validated = evmInterfaceSchema.safeParse({
        artifact: {
          path: input.path,
          sha256: carrier.sha256,
          bytes: carrier.bytes.length,
          encoding,
        },
        bytecode: {
          ...reply.bytecode,
          digest_algorithm: "sha256",
          kind: compilerArtifact?.selection.bytecode_kind ?? "unknown",
          deployment_authenticity: "unknown",
          hardfork: "unknown",
        },
        ...(compilerArtifact === undefined
          ? {}
          : {
              compiler_artifact: compilerArtifact,
              inference_status:
                compilerArtifact.status === "concrete"
                  ? "examined"
                  : "unavailable",
            }),
        evidence_kind: "inferred",
        functions:
          reply.raw === null ? [] : projectEvmoleInterface(reply.raw).functions,
        discovery_completeness: "unknown",
        runtime_execution: "not-performed",
        diagnostics: {
          stdout: execution.stdout.text,
          stderr: execution.stderr.text,
          truncated: capturedOutput.truncated,
        },
        limitations,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          OPERATION,
          `Interface worker returned invalid bytecode-relative evidence: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          { capturedOutput },
        );
      const report = validated.data;
      result = ok(
        createAnalysisExecution(report, EVMOLE_PROVIDER_IDENTITY, {
          rawResult: reply.raw,
          subject: { path: input.path, format: "file", sha256: carrier.sha256 },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations,
        }),
      );
    } catch (cause: unknown) {
      if (cause instanceof OwnedCommandFailure)
        processOwner = cause.cleanupOwner;
      let fileFailure: EvmFileSizeFailureEvidence | undefined;
      if (
        cause instanceof OwnedCommandFailure &&
        cause.snapshot?.exitCode === EVM_FILE_SIZE_FAILURE_EXIT &&
        cause.snapshot.signal === null &&
        root !== undefined
      ) {
        try {
          const marker = await readStableArtifact(
            join(root.path, "resource.failure"),
            1,
          );
          if (!marker.bytes.equals(Buffer.from("F")))
            throw new Error(
              "Private worker failure marker does not match the observed exit status.",
            );
          fileFailure = { verified: true, failure: null };
        } catch (markerFailure: unknown) {
          fileFailure = {
            verified: false,
            failure:
              markerFailure instanceof Error
                ? markerFailure.message
                : String(markerFailure),
          };
        }
      }
      result = err(
        options?.signal?.aborted &&
          (cause === options.signal.reason ||
            (cause instanceof Error && cause.name === "AbortError"))
          ? new AnalysisCancelledError(
              OPERATION,
              retainedOutput === undefined
                ? undefined
                : { capturedOutput: retainedOutput },
            )
          : evmInterfaceFailure(
              cause,
              phase,
              input.path,
              workerLimits,
              limiter,
              fileFailure,
            ),
      );
    }
    if (processOwner !== undefined) {
      this.#pendingCleanup = { root, process: processOwner };
      // The command failure already owns this cleanup diagnostic and its resources.
      return result;
    }
    if (root !== undefined) {
      try {
        await root.close();
      } catch (cause: unknown) {
        const retainedRoot = root;
        this.#pendingCleanup = { root: retainedRoot, process: undefined };
        root = undefined;
        return err(
          new ProviderCleanupError(
            EVMOLE_PROVIDER_IDENTITY.id,
            [retainedRoot.path],
            {
              reason: cause instanceof Error ? cause.message : String(cause),
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
              ...(retainedOutput === undefined
                ? {}
                : { captured_output: { ...retainedOutput } }),
            },
            { operation: OPERATION },
          ),
        );
      }
    }
    return result.ok && options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(
            OPERATION,
            retainedOutput === undefined
              ? undefined
              : { capturedOutput: retainedOutput },
          ),
        )
      : result;
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const failure = await this.#retire();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #closedError(): ProviderCleanupError {
    return new ProviderCleanupError(
      EVMOLE_PROVIDER_IDENTITY.id,
      [],
      { reason: "Provider is closing" },
      { operation: OPERATION },
    );
  }

  async #retire(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete")
        return new ProviderCleanupError(
          EVMOLE_PROVIDER_IDENTITY.id,
          [pending.process.launch.ownership?.runId ?? "owned-worker"],
          { reason: stopped.reason },
          { operation: OPERATION },
        );
      pending.process = undefined;
    }
    if (pending.root !== undefined) {
      const root = pending.root;
      try {
        await root.close();
        pending.root = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          EVMOLE_PROVIDER_IDENTITY.id,
          [root.path],
          { reason: cause instanceof Error ? cause.message : String(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
