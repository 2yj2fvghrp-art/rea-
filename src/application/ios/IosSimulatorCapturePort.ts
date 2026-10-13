import type { ExecutionOptions } from "../AnalysisProvider.js";
import type {
  IosSimulatorCaptureInput,
  IosSimulatorCaptureResult,
} from "../../domain/ios/iosSimulatorCapture.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type { EvidenceProvider } from "../../domain/evidence.js";

/** Provider-specific simulator acquisition behind the shared CLI/MCP workflow. */
export interface IosSimulatorCapturePort {
  identity(): EvidenceProvider;
  capture(
    input: IosSimulatorCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<IosSimulatorCaptureResult, AnalysisError>>;
}
