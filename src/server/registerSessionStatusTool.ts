import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  buildCapabilityInventory,
  compactToolAvailability,
} from "../application/CapabilityInventory.js";
import { toolContract } from "../contracts/toolContracts.js";
import type {
  ClientFeatureAvailability,
  ToolAvailability,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { err } from "../domain/result.js";

/** Inputs required to register the binary session status tool. */
export interface SessionStatusToolOptions {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly contract: ReturnType<typeof toolContract<"binary_session">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => AvailabilityPolicy;
  readonly androidAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly adbAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly apktoolAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly jebAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
}

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  options: SessionStatusToolOptions,
): void => {
  const {
    server,
    session,
    contract,
    startedAt,
    availabilityPolicy,
    androidAnalysisAvailability,
    adbAnalysisAvailability,
    apktoolAnalysisAvailability,
    jebAnalysisAvailability,
  } = options;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const { client, clientFeatures, protocolVersion } = mcpClientMetadata(
        context,
        server.server,
      );
      const signal = context.mcpReq.signal;
      let engines: readonly [
        ProviderAvailability,
        ProviderAvailability,
        ProviderAvailability,
        ProviderAvailability,
      ];
      try {
        engines = await Promise.all([
          androidAnalysisAvailability(signal),
          adbAnalysisAvailability(signal),
          apktoolAnalysisAvailability(signal),
          jebAnalysisAvailability(signal),
        ]);
      } catch (cause) {
        if (!signal.aborted) throw cause;
        return server.delivery.toCallToolResult(
          err(new AnalysisCancelledError("binary_session")),
          contract,
        );
      }
      const [
        androidAvailability,
        adbAvailability,
        apktoolAvailability,
        jebAvailability,
      ] = engines;
      const status = session.status();
      const statusObject = jsonObjectSchema.parse(status);
      const toolAvailability = buildCapabilityInventory(
        status,
        {
          ...availabilityPolicy(),
          androidAnalysisAvailability: androidAvailability,
          adbAnalysisAvailability: adbAvailability,
          apktoolAnalysisAvailability: apktoolAvailability,
          jebAnalysisAvailability: jebAvailability,
        },
        clientFeatures,
      );
      const serverIdentity = createServerIdentity({
        startedAt,
        expected: {
          ...(input.expected_package_version === undefined
            ? {}
            : { package_version: input.expected_package_version }),
          ...(input.expected_catalog_digest === undefined
            ? {}
            : { catalog_digest: input.expected_catalog_digest }),
          ...(input.expected_server_path === undefined
            ? {}
            : { server_path: input.expected_server_path }),
        },
        ...(client === undefined ? {} : { client }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      });
      return server.delivery.toCallToolResult(
        {
          ok: true,
          value: projectSessionStatus({
            status: statusObject,
            toolAvailability,
            serverIdentity,
            clientFeatures,
          }),
        },
        contract,
      );
    },
  );
};

const projectSessionStatus = (options: {
  readonly status: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) =>
  jsonObjectSchema.parse({
    ...options.status,
    tool_availability: compactToolAvailability(options.toolAvailability),
    client_features: options.clientFeatures,
    server_identity: options.serverIdentity,
  });
