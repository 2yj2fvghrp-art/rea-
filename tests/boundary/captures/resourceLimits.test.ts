import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { TsharkCaptureProvider } from "../../../src/captures/TsharkCaptureProvider.js";
import { PacketCaptureService } from "../../../src/application/captures/PacketCaptureService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Real kernel-limit verification with a synthetic producer; real TShark has its own verifier.
it.skipIf(process.platform !== "linux")(
  "enforces both address-space limits before any producer allocation",
  async () => {
    const directory = await createTestTempDirectory("rea-tshark-limits-");
    const command = join(directory, "memory-probe");
    await writeFile(
      command,
      `#!/usr/bin/python3
import json, resource, sys
assert resource.getrlimit(resource.RLIMIT_AS) == (1073741824, 1073741824)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (67108864, 67108864)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
if '--version' in sys.argv:
    print('TShark (Wireshark) 4.6.9 (resource fixture)')
else:
    try:
        bytearray(1073741825)
    except MemoryError:
        print(json.dumps([{'_source': {'layers': {'frame.number': ['1']}}}]))
    else:
        raise RuntimeError('allocation unexpectedly succeeded')
`,
      { mode: 0o700 },
    );
    const path = join(directory, "recording.pcap");
    await writeFile(path, "selected fixture");
    const service = new PacketCaptureService(
      new TsharkCaptureProvider({
        ...process.env,
        REA_TSHARK_COMMAND: command,
      }),
    );
    onTestFinished(() => service.close());
    const result = await service.inspect({ path, fields: ["frame.number"] });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      packets: [{ "frame.number": ["1"] }],
      limits: { address_space_bytes: 1073741824 },
    });
  },
);
