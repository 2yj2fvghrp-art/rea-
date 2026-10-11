import {
  pcapInputSchemas,
  pcapResultSchemas,
} from "../../domain/pcap/pcapAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Packet-capture analysis served by caller-supplied tshark and capinfos. */
export const PCAP_TOOL_CONTRACTS = [
  {
    name: "inspect_pcap_client",
    ...toolContractMetadata("inspect_pcap_client"),
    description:
      "Inspect the caller-selected tshark and capinfos binaries: resolved commands, selection sources, and versions. Reads no capture file. REA never installs the Wireshark suite; select binaries with REA_TSHARK_COMMAND and REA_CAPINFOS_COMMAND (absolute) or from PATH.",
    kind: "pcap-provider",
    inputSchema: pcapInputSchemas.inspect_pcap_client,
    outputSchema: evidenceResultOf(pcapResultSchemas.inspect_pcap_client),
    examples: [{ title: "Check the analysis tools", input: {} }],
  },
  {
    name: "inspect_pcap_capture",
    ...toolContractMetadata("inspect_pcap_capture"),
    description:
      "Inspect one saved pcap or pcapng capture file through capinfos and tshark: file type, encapsulation, packet count, capture timing, snapshot length, SHA-256 digest, endpoint inventory with packet counts, DNS queries with resolved addresses, TLS Server Name Indication values, protocol distribution, and plain-text HTTP request URIs — each bounded with partial coverage on truncation. REA never captures traffic; this reads an already-saved file.",
    kind: "pcap-provider",
    inputSchema: pcapInputSchemas.inspect_pcap_capture,
    outputSchema: evidenceResultOf(pcapResultSchemas.inspect_pcap_capture),
    examples: [
      {
        title: "Inspect a capture file",
        input: { path: "/captures/session.pcap" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
