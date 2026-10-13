import { IosSimulatorCaptureService } from "../application/ios/IosSimulatorCaptureService.js";
import { SimctlSimulatorCapture } from "../ios/SimctlSimulatorCapture.js";
import type { IosSimulatorCapturePort } from "../application/ios/IosSimulatorCapturePort.js";

/** Construct the shared simulator capture workflow without invoking Xcode. */
export const createIosSimulatorCaptureService = (
  provider?: IosSimulatorCapturePort,
): IosSimulatorCaptureService =>
  new IosSimulatorCaptureService(provider ?? new SimctlSimulatorCapture());
