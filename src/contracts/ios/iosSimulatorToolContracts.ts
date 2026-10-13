import {
  iosSimulatorCaptureInputSchema,
  iosSimulatorCaptureResultSchema,
} from "../../domain/ios/iosSimulatorCapture.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Existing booted iOS Simulator display capture; physical devices are excluded. */
export const IOS_SIMULATOR_TOOL_CONTRACTS = [
  {
    name: "capture_ios_simulator_screen",
    ...toolContractMetadata("capture_ios_simulator_screen"),
    description:
      "Capture the current display of one already-booted iOS Simulator selected by exact CoreSimulator UDID. Returns complete PNG bytes inline as canonical base64 within a 3 MiB source-byte transport budget, dimensions, SHA-256, simulator identity and Evidence. Does not boot, install, launch, tap or modify an app. The foreground application, view hierarchy and application artifact identity remain unknown. macOS/Xcode CoreSimulator only; no physical device support. Capability inventory reports host eligibility; installed tools and selected simulator are checked at invocation.",
    kind: "native-provider",
    inputSchema: iosSimulatorCaptureInputSchema,
    outputSchema: evidenceResultOf(iosSimulatorCaptureResultSchema),
    examples: [
      {
        title: "Capture a booted simulator display",
        input: { simulator_udid: "9D5B01E1-9CCE-4F37-9EE9-24BD56FDF401" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
