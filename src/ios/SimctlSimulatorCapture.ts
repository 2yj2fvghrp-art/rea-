import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { IosSimulatorCapturePort } from "../application/ios/IosSimulatorCapturePort.js";
import {
  iosSimulatorCaptureResultSchema,
  parsePngDimensions,
  type IosSimulatorCaptureInput,
  type IosSimulatorCaptureResult,
} from "../domain/ios/iosSimulatorCapture.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { IOS_SIMULATOR_PROVIDER_IDENTITY } from "./providerIdentity.js";

const OPERATION = "capture_ios_simulator_screen";
const PROVIDER = IOS_SIMULATOR_PROVIDER_IDENTITY.id;
const COMMAND_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 60_000;
// A 3 MiB PNG expands to about 4 MiB of base64 and appears twice in the
// structured MCP Evidence result; this stays within the 10 MiB stdio budget.
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 128 * 1024;

const simulatorSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(),
  isAvailable: z.boolean(),
  deviceTypeIdentifier: z.string(),
});
const listSchema = z.object({
  devices: z.record(z.string(), z.array(simulatorSchema)),
});
type Simulator = z.infer<typeof simulatorSchema> & {
  readonly runtimeId: string;
};

type RuntimeRoot = Awaited<
  ReturnType<NonNullable<SimctlCaptureOptions["createRuntime"]>>
>;

interface SimctlCommand {
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly phase: string;
  readonly udid: string;
}

export interface SimctlCaptureOptions {
  readonly xcrunPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: typeof runOwnedCommand;
  readonly createRuntime?: (options: { readonly prefix: string }) => Promise<{
    readonly path: string;
    close(): Promise<void>;
  }>;
}

/** Read an existing iOS Simulator display with owned simctl subprocesses. */
export class SimctlSimulatorCapture implements IosSimulatorCapturePort {
  private readonly xcrunPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: typeof runOwnedCommand;
  private readonly createRuntime: NonNullable<
    SimctlCaptureOptions["createRuntime"]
  >;

  constructor(options: SimctlCaptureOptions = {}) {
    this.xcrunPath = options.xcrunPath ?? "/usr/bin/xcrun";
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runOwnedCommand;
    this.createRuntime = options.createRuntime ?? PrivateRuntimeRoot.create;
  }

  /** Name the actual producing adapter without placing its identity in application code. */
  identity() {
    return IOS_SIMULATOR_PROVIDER_IDENTITY;
  }

  /** Check simulator identity before and after a bounded PNG capture. */
  async capture(
    input: IosSimulatorCaptureInput,
    options: ExecutionOptions = {},
  ): Promise<Result<IosSimulatorCaptureResult, AnalysisError>> {
    if (options.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    if (this.platform !== "darwin")
      return err(
        new AnalysisCapabilityUnavailableError(
          PROVIDER,
          OPERATION,
          "iOS Simulator capture requires macOS and the caller's installed Xcode CoreSimulator tools.",
        ),
      );
    let root: RuntimeRoot | undefined;
    let result: IosSimulatorCaptureResult | undefined;
    let failure: AnalysisError | undefined;
    try {
      const before = await this.selectedSimulator(
        input.simulator_udid,
        options.signal,
      );
      root = await this.createRuntime({ prefix: "rea-ios-simulator-" });
      result = await this.captureInto(input, before, root.path, options.signal);
    } catch (cause: unknown) {
      failure = this.mapFailure(cause, "capture", input.simulator_udid);
    }
    failure = await this.cleanupRoot(root, failure);
    if (failure !== undefined) return err(failure);
    if (result === undefined)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Capture completed without a result.",
        ),
      );
    return ok(result);
  }

  private async captureInto(
    input: IosSimulatorCaptureInput,
    before: Simulator,
    rootPath: string,
    signal: AbortSignal | undefined,
  ): Promise<IosSimulatorCaptureResult> {
    const screenshotPath = join(rootPath, "display.png");
    await this.command({
      arguments: [
        "simctl",
        "io",
        before.udid,
        "screenshot",
        "--type=png",
        screenshotPath,
      ],
      timeoutMs: CAPTURE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      phase: "screenshot",
      udid: before.udid,
    });
    const bytes = await this.readScreenshot(screenshotPath);
    const dimensions = parsePngDimensions(bytes);
    if (dimensions === null)
      throw new AnalysisOutputError(
        OPERATION,
        "simctl produced a PNG with incomplete or invalid chunk structure.",
      );
    const after = await this.selectedSimulator(input.simulator_udid, signal);
    if (
      before.udid !== after.udid ||
      before.runtimeId !== after.runtimeId ||
      before.deviceTypeIdentifier !== after.deviceTypeIdentifier
    )
      throw new AnalysisUnsupportedTargetError(
        OPERATION,
        input.simulator_udid,
        "Simulator identity changed during capture; retry with its current exact UDID.",
      );
    const parsed = iosSimulatorCaptureResultSchema.safeParse({
      simulator: {
        udid: before.udid,
        name: before.name,
        runtime_id: before.runtimeId,
        device_type_id: before.deviceTypeIdentifier,
        state: "Booted",
      },
      screenshot: {
        mime_type: "image/png",
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_length: bytes.length,
        ...dimensions,
      },
      foreground_application: null,
      captured_at: new Date().toISOString(),
      limitations: [
        "This captures the selected simulator display only; the foreground application, its artifact identity and any view hierarchy remain unknown.",
        "Physical iOS devices and device control are outside this operation.",
      ],
    });
    if (!parsed.success)
      throw new AnalysisOutputError(
        OPERATION,
        "simctl screenshot metadata failed result validation.",
        { cause: parsed.error },
      );
    return parsed.data;
  }

  private async readScreenshot(path: string): Promise<Buffer> {
    let file: Awaited<ReturnType<typeof stat>>;
    try {
      file = await stat(path);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        throw new AnalysisOutputError(
          OPERATION,
          "simctl completed without producing a PNG screenshot.",
          { cause },
        );
      throw cause;
    }
    if (!file.isFile())
      throw new AnalysisOutputError(
        OPERATION,
        "simctl did not produce a regular PNG file.",
      );
    if (file.size > MAX_SCREENSHOT_BYTES)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        "Simulator PNG exceeds the complete inline capture budget.",
        {
          screenshot_bytes: file.size,
          max_screenshot_bytes: MAX_SCREENSHOT_BYTES,
        },
      );
    const bytes = await readFile(path);
    if (bytes.length > MAX_SCREENSHOT_BYTES)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        "Simulator PNG grew beyond the complete inline capture budget.",
        {
          screenshot_bytes: bytes.length,
          max_screenshot_bytes: MAX_SCREENSHOT_BYTES,
        },
      );
    return bytes;
  }

  private async cleanupRoot(
    root: RuntimeRoot | undefined,
    original: AnalysisError | undefined,
  ): Promise<AnalysisError | undefined> {
    if (root === undefined) return original;
    try {
      await root.close();
      return original;
    } catch (cause: unknown) {
      return new ProviderAdapterError(PROVIDER, OPERATION, {
        cause: original ?? cause,
        ...(original?.capturedOutput === undefined
          ? {}
          : { capturedOutput: original.capturedOutput }),
        diagnostics: {
          phase: "cleanup",
          reason: cause instanceof Error ? cause.message : String(cause),
          ...(original === undefined
            ? {}
            : { execution_failure: original.message }),
          ...(original instanceof ProviderAdapterError &&
          original.diagnostics !== undefined
            ? { execution_diagnostics: original.diagnostics }
            : {}),
        },
        cleanup: {
          reason: "Temporary screenshot cleanup failed.",
          resources: [root.path],
        },
      });
    }
  }

  private async selectedSimulator(
    udid: string,
    signal: AbortSignal | undefined,
  ): Promise<Simulator> {
    const command = await this.command({
      arguments: ["simctl", "list", "devices", "--json"],
      timeoutMs: COMMAND_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      phase: "inventory",
      udid,
    });
    let decoded: unknown;
    try {
      decoded = JSON.parse(command.stdout.text);
    } catch (cause: unknown) {
      throw new AnalysisOutputError(
        OPERATION,
        "CoreSimulator device inventory was not JSON.",
        { cause },
      );
    }
    const parsed = listSchema.safeParse(decoded);
    if (!parsed.success)
      throw new AnalysisOutputError(
        OPERATION,
        "CoreSimulator device inventory did not match its expected representation.",
        { cause: parsed.error },
      );
    for (const [runtimeId, devices] of Object.entries(parsed.data.devices)) {
      const device = devices.find(
        (candidate) => candidate.udid.toUpperCase() === udid.toUpperCase(),
      );
      if (device === undefined) continue;
      if (!runtimeId.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
        throw new AnalysisUnsupportedTargetError(
          OPERATION,
          udid,
          `Selected simulator runtime is ${runtimeId}, not iOS.`,
        );
      if (!device.isAvailable || device.state !== "Booted")
        throw new AnalysisCapabilityUnavailableError(
          PROVIDER,
          OPERATION,
          `Selected iOS Simulator ${device.udid} is ${device.state}${device.isAvailable ? "" : " and unavailable"}; boot that exact device before capture.`,
        );
      return { ...device, runtimeId };
    }
    throw new AnalysisUnsupportedTargetError(
      OPERATION,
      udid,
      "No iOS Simulator with this exact UDID is present in CoreSimulator inventory.",
    );
  }

  private async command(request: SimctlCommand) {
    try {
      return await this.runCommand(
        {
          command: this.xcrunPath,
          arguments: request.arguments,
          runId: `rea-ios-simulator-${randomUUID()}`,
        },
        { timeoutMs: request.timeoutMs, diagnosticBytes: MAX_DIAGNOSTIC_BYTES },
        request.signal === undefined ? {} : { signal: request.signal },
      );
    } catch (cause: unknown) {
      throw this.mapFailure(
        cause,
        request.phase,
        request.udid,
        request.timeoutMs,
      );
    }
  }

  private mapFailure(
    cause: unknown,
    phase: string,
    udid: string,
    timeoutMs = CAPTURE_TIMEOUT_MS,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof OwnedCommandFailure) {
      const capturedOutput =
        cause.snapshot === null
          ? undefined
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated === true,
              stdout_bytes: cause.snapshot.stdout.bytes,
              stderr_bytes: cause.snapshot.stderr.bytes,
              exit_code: cause.snapshot.exitCode ?? null,
              signal: cause.snapshot.signal ?? null,
            };
      const cleanup =
        cause.cleanupFailure === null
          ? undefined
          : { reason: cause.cleanupFailure, resources: cause.resources };
      const options = {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
        ...(cleanup === undefined ? {} : { cleanup }),
      };
      if (cause.reason === "cancelled")
        return new AnalysisCancelledError(OPERATION, options);
      if (cause.reason === "timeout")
        return new AnalysisTimeoutError(OPERATION, timeoutMs, options);
      if (cause.reason === "output-limit")
        return new AnalysisResourceConstraintError(
          OPERATION,
          "transport",
          "simctl diagnostic output exceeded its complete-output budget.",
          { max_diagnostic_bytes: MAX_DIAGNOSTIC_BYTES },
          options,
        );
      return new ProviderAdapterError(PROVIDER, OPERATION, {
        ...options,
        diagnostics: { phase, simulator_udid: udid, reason: cause.message },
      });
    }
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return new AnalysisCapabilityUnavailableError(
        PROVIDER,
        OPERATION,
        `Xcode command-line tool ${this.xcrunPath} is unavailable.`,
        { cause },
      );
    return new ProviderAdapterError(PROVIDER, OPERATION, {
      cause,
      diagnostics: {
        phase,
        simulator_udid: udid,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }
}
