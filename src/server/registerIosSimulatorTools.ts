import type { Logger } from "pino";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { IosSimulatorCaptureService } from "../application/ios/IosSimulatorCaptureService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Register the exact named iOS Simulator contract through the shared workflow. */
export const registerIosSimulatorTools = (
  server: EvidenceMcpServer,
  service: IosSimulatorCaptureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("capture_ios_simulator_screen");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.execute(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  )(contract);
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const delivered = await handler(input, context);
      if (delivered.isError === true) return delivered;
      const evidence = delivered.structuredContent;
      if (!record(evidence)) return delivered;
      const screenshot = evidence.normalized_result;
      const screenshotDetails = record(screenshot)
        ? screenshot.screenshot
        : null;
      // The complete PNG remains in structuredContent. Repeating it in text
      // would multiply the stdio payload and can exceed MCP's receive budget.
      return {
        ...delivered,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              evidence_id: evidence.evidence_id,
              result: {
                simulator: record(screenshot) ? screenshot.simulator : null,
                screenshot: record(screenshotDetails)
                  ? {
                      sha256: screenshotDetails.sha256,
                      byte_length: screenshotDetails.byte_length,
                      width: screenshotDetails.width,
                      height: screenshotDetails.height,
                      mime_type: screenshotDetails.mime_type,
                    }
                  : null,
                foreground_application: null,
              },
              complete_png:
                "structuredContent.normalized_result.screenshot.base64",
            }),
          },
        ],
      };
    },
  );
};
