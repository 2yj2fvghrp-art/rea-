# Packet capture analysis

REA inspects saved pcap and pcapng capture files through the caller's
tshark and capinfos binaries from the Wireshark suite. It answers analyst
questions about observed hosts, DNS, TLS, and protocol distributions from
a local capture file, complementing the HTTP-level HAR and mitmproxy
family with the packet layer below it.

REA never captures traffic itself and never installs the Wireshark suite;
both operations read an already-saved file.

## Supply tools

Use tshark and capinfos from any Wireshark installation (verified with
4.6.6). Select them through the environment:

```sh
# Optional: absolute paths; without them, both resolve from PATH.
export REA_TSHARK_COMMAND=/absolute/path/tshark
export REA_CAPINFOS_COMMAND=/absolute/path/capinfos
```

Readiness is `rea inspect-pcap-client`: it runs `--version` on both
binaries and reports their resolved commands, selection sources, and
versions. Missing binaries report `capability_unavailable` with the
`REA_TSHARK_COMMAND` remediation rather than attempting an installation.

## Answer an analyst question

```sh
rea inspect-pcap-client
rea inspect-pcap-capture /captures/session.pcap
```

Equivalent MCP methods are `inspect_pcap_client` and
`inspect_pcap_capture` with the same `path`.

## Interpret the result

- **`target.sha256`** binds the observation to the exact capture file.
- **`file_type`** distinguishes pcap from pcapng as capinfos reports it;
  **`encapsulation`** names the link-layer format (Ethernet, Linux
  cooked-mode, etc.).
- **`packet_count`**, **`capture_start`**/**`capture_end`**, and
  **`capture_duration_seconds`** describe the capture window.
- **`endpoints`** lists distinct IP addresses with packet counts, bounded
  to 200 with `endpoint_count` reporting the true total.
- **`dns_queries`** lists observed DNS queries with their resolved
  addresses (A and AAAA), bounded to 100.
- **`tls_sni_values`** reports Server Name Indication from TLS
  handshakes — the hostname evidence in encrypted traffic.
- **`protocol_distribution`** counts each `frame.protocols` value.
- **`http_request_uris`** lists plain-text HTTP requests, bounded to 50.
- **`coverage: "partial"`** appears when any category was truncated.
- The capture's own SHA-256 from capinfos is compared against REA's
  digest; a mismatch is reported as a limitation.

## Resource and lifecycle limits

- tshark output is budgeted at 64 MiB; capinfos at 64 KiB; both tools
  run with a timeout (300 s for tshark, 60 s for capinfos).
- The capture file is digested with streaming SHA-256 before analysis.
- Cancellation is checked between digest chunks and after tool
  invocations.
- REA runs no subprocess for `inspect_pcap_client` beyond `--version`.

## Companion flows

With the ADB family, a complete Android triage is one session:
`pull_adb_file` retrieves a capture produced on-device by tcpdump or
iptables NFLOG, then `inspect_pcap_capture` decodes it. The network
capture roadmap documents per-app filtering through iptables owner match
feeding NFLOG with per-packet UID attribution.

## Platform coverage

The provider is platform-agnostic — it spawns whatever binary
`REA_TSHARK_COMMAND` points to and parses its stdout. Cross-platform
tests exercise the provider contract through `.cmd` (Windows) and
`.sh` (POSIX) stub scripts, validating tool probing, capture
inspection, refusal paths, and cancellation on both platforms.

**Real-engine verification is Linux-only** (Docker `rea-tshark` image and
Android emulator). Windows and macOS have not been verified against real
tshark/capinfos binaries; the stub tests confirm the provider's contract
surface, but the tools' output format, path resolution, and process
behavior on those platforms are untested. Report real-tool verification
results as they become available.

## Real verification

`npm run verify:pcap -- --pcap PATH` exercises both operations against a
real capture file. Record: tshark/capinfos 4.6.6 (Alpine Docker image)
against two real captures: a 50-packet Docker-captured pcap with DNS,
TLS, and HTTP traffic, and a 30-packet Android emulator capture (tcpdump
on-device, pulled via `adb pull`) containing DNS, mDNS, ICMP, and Google
endpoints — file type, encapsulation, packet count, SHA-256 digest
agreement, endpoint inventory, DNS queries, TLS SNI values, protocol
distribution, and HTTP URIs all verified on both. Parser goldens in the
test suite come from the same tools.
