import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { PcapRequest } from "../domain/pcap/pcapAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  PcapConfigurationFailure,
  inspectPcapClient,
  resolvePcapTools,
  type PcapToolSelection,
  type PcapClientIdentity,
} from "./PcapConfiguration.js";
import { parseCapinfosOutput, parseTsharkJsonOutput } from "./PcapOutput.js";

/** Stable identity for the pcap analysis provider. */
export const PCAP_PROVIDER_IDENTITY = {
  id: "pcap",
  name: "Packet capture analysis",
  version: null,
} as const;

const CAPINFOS_TIMEOUT_MS = 60_000;
const CAPINFOS_MAX_OUTPUT_BYTES = 64 * 1024;
const TSHARK_TIMEOUT_MS = 300_000;
const TSHARK_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ENDPOINTS = 200;
const MAX_DNS_QUERIES = 100;
const MAX_SNI_VALUES = 50;
const MAX_PROTOCOLS = 50;
const MAX_HTTP_URIS = 50;
const STDERR_EXCERPT_BYTES = 512;

/** Stream a local file digest without retaining large captures in memory. */
const sha256File = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted === true) throw new AnalysisCancelledError("digest");
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
};

const runTool = async (
  operation: string,
  command: string,
  arguments_: readonly string[],
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  signal: AbortSignal | undefined,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const abortReason = signal?.reason;
  try {
    return ok(
      await execFileOutput(command, arguments_, {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        stopSignal: "SIGTERM",
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  } catch (cause) {
    if (abortReason !== undefined)
      return err(new AnalysisCancelledError(operation, { cause: abortReason }));
    const failure = execFileOutputFailure(cause);
    if (failure === undefined)
      return err(
        new AnalysisProtocolError(`tool failed for ${operation}`, { cause }),
      );
    if (failure.outputTruncated)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          `output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
          { max_output_bytes: limits.maxOutputBytes },
          { cause },
        ),
      );
    const excerpt = failure.stderr.trim().slice(0, STDERR_EXCERPT_BYTES);
    if (/not a capture file|unrecognized|invalid/iu.test(excerpt))
      return err(
        new AnalysisUnsupportedTargetError(operation, command, excerpt, {
          cause,
        }),
      );
    if (failure.killed)
      return err(
        new AnalysisTimeoutError(operation, limits.timeoutMs, { cause }),
      );
    return err(
      new AnalysisProtocolError(
        excerpt === ""
          ? `exited with code ${String(failure.code)} for ${operation}`
          : excerpt,
        { cause },
      ),
    );
  }
};

export interface PcapProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Packet-capture analysis through caller-supplied tshark and capinfos.
 * REA never installs the Wireshark suite and never captures traffic;
 * both operations read an already-saved pcap or pcapng file.
 */
export class PcapProvider {
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(options: PcapProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  private selection(): PcapToolSelection {
    return resolvePcapTools(this.environment);
  }

  /** Probe both tools without reading any capture file. */
  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const selection = this.selection();
    const identity = await inspectPcapClient(selection, signal);
    if (identity.tsharkVersion === null)
      return {
        status: "unavailable",
        code: "executable_missing",
        reason: `The selected tshark binary was not found or did not report a version: ${selection.tshark.command}`,
        diagnostics: {
          selected_command: selection.tshark.command,
          command_source: selection.tshark.source,
          remediation: "Set REA_TSHARK_COMMAND to an absolute tshark path",
        },
      };
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        tshark_command: selection.tshark.command,
        tshark_version: identity.tsharkVersion,
        capinfos_command: selection.capinfos.command,
        capinfos_version: identity.capinfosVersion,
      },
    };
  }

  /** The provider holds no long-lived resources. */
  async close(): Promise<void> {}

  async execute(
    request: PcapRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const selection = this.selection();
    let identity: PcapClientIdentity;
    try {
      identity = await inspectPcapClient(selection, options?.signal);
    } catch (cause) {
      if (cause instanceof PcapConfigurationFailure)
        return err(
          new AnalysisCapabilityUnavailableError(
            PCAP_PROVIDER_IDENTITY.id,
            request.operation,
            cause.message,
            { cause },
          ),
        );
      return err(
        new AnalysisProtocolError(
          `tool version probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    if (identity.tsharkVersion === null)
      return err(
        new AnalysisCapabilityUnavailableError(
          PCAP_PROVIDER_IDENTITY.id,
          request.operation,
          `The selected tshark binary was not found: ${selection.tshark.command}. Set REA_TSHARK_COMMAND to an absolute path.`,
        ),
      );
    const client = {
      tshark_command: selection.tshark.command,
      tshark_source: selection.tshark.source,
      tshark_version: identity.tsharkVersion,
      capinfos_command: selection.capinfos.command,
      capinfos_source: selection.capinfos.source,
      capinfos_version: identity.capinfosVersion,
    };
    const provider = {
      ...PCAP_PROVIDER_IDENTITY,
      version: identity.tsharkVersion,
    };
    if (request.operation === "inspect_pcap_client")
      return ok(createAnalysisExecution({ client }, provider));
    return this.inspectCapture(
      request.operation,
      selection,
      client,
      provider,
      request.input.path,
      options?.signal,
    );
  }

  private async inspectCapture(
    operation: "inspect_pcap_capture",
    selection: PcapToolSelection,
    client: {
      tshark_command: string;
      tshark_source: string;
      tshark_version: string | null;
      capinfos_command: string;
      capinfos_source: string;
      capinfos_version: string | null;
    },
    provider: { id: string; name: string; version: string | null },
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const info = await stat(path).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(
            `The selected capture is not a readable file: ${path}`,
          ),
        }),
      );
    const sha256 = await sha256File(path, signal).catch(() => null);
    if (sha256 === null)
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(`The capture file could not be digested: ${path}`),
        }),
      );

    const capinfosRan = await runTool(
      operation,
      selection.capinfos.command,
      [path],
      {
        timeoutMs: CAPINFOS_TIMEOUT_MS,
        maxOutputBytes: CAPINFOS_MAX_OUTPUT_BYTES,
      },
      signal,
    );
    if (!capinfosRan.ok) return capinfosRan;
    const metadata = parseCapinfosOutput(capinfosRan.value.stdout);

    const tsharkRan = await runTool(
      operation,
      selection.tshark.command,
      [
        "-r",
        path,
        "-T",
        "json",
        "-e",
        "frame.number",
        "-e",
        "frame.protocols",
        "-e",
        "ip.src",
        "-e",
        "ip.dst",
        "-e",
        "dns.qry.name",
        "-e",
        "dns.a",
        "-e",
        "dns.aaaa",
        "-e",
        "tls.handshake.extensions_server_name",
        "-e",
        "http.request.full_uri",
      ],
      { timeoutMs: TSHARK_TIMEOUT_MS, maxOutputBytes: TSHARK_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!tsharkRan.ok) return tsharkRan;
    const fields = parseTsharkJsonOutput(tsharkRan.value.stdout, {
      maxEndpoints: MAX_ENDPOINTS,
      maxDnsQueries: MAX_DNS_QUERIES,
      maxSniValues: MAX_SNI_VALUES,
      maxProtocols: MAX_PROTOCOLS,
      maxHttpUris: MAX_HTTP_URIS,
    });

    const partial =
      fields.endpointCount > MAX_ENDPOINTS ||
      fields.dnsQueryCount > MAX_DNS_QUERIES ||
      fields.httpRequestUriCount > MAX_HTTP_URIS;

    return ok(
      createAnalysisExecution(
        {
          client,
          target: { path, bytes: info.size, sha256 },
          file_type: metadata.fileType,
          encapsulation: metadata.encapsulation,
          packet_count: metadata.packetCount,
          capture_start: metadata.captureStart,
          capture_end: metadata.captureEnd,
          capture_duration_seconds: metadata.captureDurationSeconds,
          snapshot_length: metadata.snapshotLength,
          endpoints: fields.endpoints,
          endpoint_count: fields.endpointCount,
          dns_queries: fields.dnsQueries,
          dns_query_count: fields.dnsQueryCount,
          tls_sni_values: fields.tlsSniValues,
          protocol_distribution: fields.protocolDistribution,
          http_request_uris: fields.httpRequestUris,
          http_request_uri_count: fields.httpRequestUriCount,
          coverage: partial ? "partial" : "complete",
        },
        provider,
        {
          limitations: [
            "The capture file is read as an immutable local artifact; REA never captures traffic",
            ...(metadata.sha256 !== null && metadata.sha256 !== sha256
              ? [
                  `capinfos reports SHA256 ${metadata.sha256} while REA computed ${sha256}; the file may have changed during analysis`,
                ]
              : []),
            ...(fields.endpointCount > MAX_ENDPOINTS
              ? [
                  `endpoints reports the top ${String(MAX_ENDPOINTS)} of ${String(fields.endpointCount)} distinct addresses`,
                ]
              : []),
            ...(fields.dnsQueryCount > MAX_DNS_QUERIES
              ? [
                  `dns_queries reports the first ${String(MAX_DNS_QUERIES)} of ${String(fields.dnsQueryCount)} distinct queries`,
                ]
              : []),
          ],
        },
      ),
    );
  }
}
