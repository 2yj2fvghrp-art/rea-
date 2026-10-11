import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { PcapProvider } from "./PcapProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { PcapRequest } from "../domain/pcap/pcapAnalysis.js";

const it = test.skipIf(process.platform === "win32");

const CAPINFOS_OUTPUT = [
  "File name:           /work/capture.pcap",
  "File type:           Wireshark/tcpdump/... - pcap",
  "File encapsulation:  Ethernet",
  "Packet size limit:   file hdr: 262144 bytes",
  "Number of packets:   3",
  "Capture duration:    0.123 seconds",
  "SHA256:              irrelevant",
].join("\n");

const TSHARK_JSON = JSON.stringify([
  {
    _source: {
      layers: {
        "frame.number": ["1"],
        "frame.protocols": ["eth:ethertype:ip:udp:dns"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["8.8.8.8"],
        "dns.qry.name": ["api.example.com"],
        "dns.a": ["93.184.216.34"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["2"],
        "frame.protocols": ["eth:ethertype:ip:tcp:tls"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["93.184.216.34"],
        "tls.handshake.extensions_server_name": ["api.example.com"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["3"],
        "frame.protocols": ["eth:ethertype:ip:tcp:http"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["93.184.216.34"],
        "http.request.full_uri": ["http://api.example.com/v1/data"],
      },
    },
  },
]);

const writeStubTools = async (
  root: string,
  options: { readonly failCapinfos?: boolean } = {},
): Promise<{ tshark: string; capinfos: string }> => {
  const tshark = join(root, "tshark");
  const capinfos = join(root, "capinfos");
  await writeFile(
    tshark,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'TShark (Wireshark) 4.6.6-stub\\n'; exit 0; fi
if [ "$1" = "-r" ] && echo "$2" | grep -q "fail"; then
  printf 'tshark: The file is not a capture file' >&2; exit 1
fi
printf '%s' '${TSHARK_JSON.replace(/'/gu, "'\\''")}'
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    capinfos,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'Capinfos (Wireshark) 4.6.6-stub\\n'; exit 0; fi
if [ "$1" != "--version" ] && echo "$*" | grep -q "fail"; then
  printf 'capinfos: The file is not a capture file' >&2; exit 1
fi
printf '%s\\n' '${CAPINFOS_OUTPUT.replace(/'/gu, "'\\''")}'
exit 0
`,
    { mode: 0o755 },
  );
  await chmod(tshark, 0o755);
  await chmod(capinfos, 0o755);
  return { tshark, capinfos };
};

const providerWith = async () => {
  const root = await mkdtemp(join("/tmp", "rea-pcap-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const { tshark, capinfos } = await writeStubTools(root);
  return {
    provider: new PcapProvider({
      environment: {
        REA_TSHARK_COMMAND: tshark,
        REA_CAPINFOS_COMMAND: capinfos,
      },
    }),
    root,
  };
};

const evidenceResult = async (
  provider: PcapProvider,
  request: PcapRequest,
): Promise<Record<string, unknown>> => {
  const result = await provider.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.result as Record<string, unknown>;
};

const captureFixture = async (root: string): Promise<string> => {
  const path = join(root, "capture.pcap");
  await writeFile(path, Buffer.from("pcap-fixture-bytes"));
  return path;
};

it("inspects both tools without reading a capture", async () => {
  const { provider } = await providerWith();
  const result = await evidenceResult(provider, {
    operation: "inspect_pcap_client",
    input: {},
  });
  expect(result.client).toMatchObject({
    tshark_source: "environment",
    tshark_version: "TShark (Wireshark) 4.6.6-stub",
    capinfos_source: "environment",
    capinfos_version: "Capinfos (Wireshark) 4.6.6-stub",
  });
});

it("inspects a capture with endpoints, DNS, TLS SNI, and HTTP", async () => {
  const { provider, root } = await providerWith();
  const path = await captureFixture(root);
  const result = await evidenceResult(provider, {
    operation: "inspect_pcap_capture",
    input: { path },
  });
  expect(result.target).toMatchObject({
    path,
    bytes: 18,
    sha256: createHash("sha256").update("pcap-fixture-bytes").digest("hex"),
  });
  expect(result.file_type).toBe("Wireshark/tcpdump/... - pcap");
  expect(result.packet_count).toBe(3);
  expect(result.endpoints).toEqual(
    expect.arrayContaining([
      { address: "192.168.1.100", port: null, packetCount: 3 },
      { address: "8.8.8.8", port: null, packetCount: 1 },
    ]),
  );
  expect(result.dns_queries).toEqual([
    { query: "api.example.com", responseAddresses: ["93.184.216.34"] },
  ]);
  expect(result.tls_sni_values).toEqual(["api.example.com"]);
  expect(result.http_request_uris).toEqual(["http://api.example.com/v1/data"]);
  expect(result.coverage).toBe("complete");
});

it("reports a non-capture file as unsupported", async () => {
  const { provider, root } = await providerWith();
  const failPath = join(root, "fail.pcap");
  await writeFile(failPath, "not a capture file");
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path: failPath },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "unsupported_target",
  });
});

it("reports a missing tshark binary as a capability gap", async () => {
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: "/nonexistent/tshark" },
  });
  expect(await provider.inspectAvailability()).toMatchObject({
    status: "unavailable",
    code: "executable_missing",
  });
});

it("rejects a capture that is not a readable file", async () => {
  const { provider } = await providerWith();
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path: "/nonexistent/capture.pcap" },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "invalid_request",
  });
});

it("cancels before spawning anything", async () => {
  const { provider, root } = await providerWith();
  await writeFile(join(root, "spawned"), "");
  const controller = new AbortController();
  controller.abort();
  const result = await provider.execute(
    {
      operation: "inspect_pcap_capture",
      input: { path: "/some/capture.pcap" },
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
});
