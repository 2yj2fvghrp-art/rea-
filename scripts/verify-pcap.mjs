import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { PcapAnalysisService } from "../dist/application/pcap/PcapAnalysisService.js";
import { createPcapAnalysisProvider } from "../dist/composition/pcap.js";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(
    "Usage: npm run verify:pcap [-- --pcap PATH]\n" +
      "Requires caller-supplied tshark and capinfos (REA_TSHARK_COMMAND and\n" +
      "REA_CAPINFOS_COMMAND, or both on PATH). Without --pcap, only the client\n" +
      "check runs; --pcap selects a real capture file for full verification.\n",
  );
  process.exit(0);
}

const provider = createPcapAnalysisProvider(process.env);
const service = new PcapAnalysisService(provider);
let failures = 0;
const check = (name, condition, detail = "") => {
  const mark = condition ? "ok" : "FAIL";
  process.stdout.write(
    `[${mark}] ${name}${detail === "" ? "" : ` — ${detail}`}\n`,
  );
  if (!condition) failures += 1;
};

const client = await service.execute("inspect_pcap_client", {});
if (!client.ok) {
  process.stdout.write(
    `[FAIL] inspect_pcap_client — ${client.error.message}\n`,
  );
  process.exit(1);
}
const clientResult = client.value.normalized_result;
check(
  "tshark reports a version",
  typeof clientResult.client.tshark_version === "string" &&
    clientResult.client.tshark_version !== "",
  `tshark=${clientResult.client.tshark_version} capinfos=${clientResult.client.capinfos_version}`,
);

if (options.pcap !== null) {
  const { readFile } = await import("node:fs/promises");
  const inspected = await service.execute("inspect_pcap_capture", {
    path: options.pcap,
  });
  if (!inspected.ok) {
    process.stdout.write(
      `[FAIL] inspect_pcap_capture — ${inspected.error.message}\n`,
    );
    failures += 1;
  } else {
    const r = inspected.value.normalized_result;
    const bytes = await stat(options.pcap).then((info) => info.size);
    const digest = createHash("sha256")
      .update(await readFile(options.pcap))
      .digest("hex");
    check(
      "target identity matches the file on disk",
      r.target.bytes === bytes && r.target.sha256 === digest,
      `${bytes} bytes`,
    );
    check(
      "file type and encapsulation reported",
      typeof r.file_type === "string" && typeof r.encapsulation === "string",
      `${r.file_type} / ${r.encapsulation}`,
    );
    check(
      "packet count is positive",
      typeof r.packet_count === "number" && r.packet_count > 0,
      `${r.packet_count} packets`,
    );
    check(
      "endpoint inventory is non-empty",
      r.endpoints.length > 0,
      `${r.endpoint_count} distinct`,
    );
    check(
      "protocol distribution is non-empty",
      r.protocol_distribution.length > 0,
      `${r.protocol_distribution.length} protocols`,
    );
    if (r.tls_sni_values.length > 0)
      check(
        "TLS SNI values reported",
        r.tls_sni_values.every((sni) => typeof sni === "string"),
        r.tls_sni_values.slice(0, 3).join(", "),
      );
    if (r.dns_queries.length > 0)
      check(
        "DNS queries reported",
        r.dns_queries.every((q) => typeof q.query === "string"),
        r.dns_queries
          .slice(0, 2)
          .map((q) => q.query)
          .join(", "),
      );
  }
} else {
  process.stdout.write(
    "[note] no --pcap provided; skipping capture inspection\n",
  );
}

try {
  await provider.close();
} catch (cause) {
  failures += 1;
  process.stdout.write(
    `[FAIL] provider close — ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
}

if (failures > 0) {
  process.stdout.write(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall pcap checks passed\n");

function parseArguments(argv) {
  const parsed = { help: false, pcap: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--pcap") {
      parsed.pcap = argv[index + 1] ?? null;
      index += 1;
    } else {
      process.stderr.write(`unknown argument: ${argument}\n`);
      process.exit(2);
    }
  }
  return parsed;
}
