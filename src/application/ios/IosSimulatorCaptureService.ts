import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { IosSimulatorCapturePort } from "./IosSimulatorCapturePort.js";
import { iosSimulatorCaptureInputSchema } from "../../domain/ios/iosSimulatorCapture.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "capture_ios_simulator_screen";

/** Shared capture and Evidence composition used by both CLI and MCP. */
export class IosSimulatorCaptureService {
  constructor(readonly provider: IosSimulatorCapturePort) {}

  /** Capture the selected booted simulator display without changing its state. */
  async execute(
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = iosSimulatorCaptureInputSchema.safeParse(input);
    if (!parsed.success)
      return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
    const captured = await this.provider.capture(parsed.data, options);
    if (!captured.ok) return captured;
    return ok(
      createEvidence(undefined, this.provider.identity(), {
        predicateType: "rea.ios-simulator-display",
        operation: OPERATION,
        parameters: jsonObjectSchema.parse(parsed.data),
        result: jsonValueSchema.parse(captured.value),
        confidence: "observed",
        authority: "external-service",
        environment: {
          id: `ios-simulator:${captured.value.simulator.udid}`,
          platform: "macOS",
          architecture: process.arch,
          isolation: "process",
        },
        subjectUnavailableReason:
          "The displayed application and its artifact identity are unknown; the observation is bound to the simulator UDID and screenshot digest.",
        limitations: captured.value.limitations,
      }),
    );
  }
}
