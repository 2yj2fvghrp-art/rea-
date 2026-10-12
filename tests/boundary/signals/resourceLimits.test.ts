import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { SigrokRecordingProvider } from "../../../src/signals/SigrokRecordingProvider.js";
import { SignalRecordingService } from "../../../src/application/signals/SignalRecordingService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Real kernel-limit verification with a synthetic producer; real sigrok has its own verifier.
it.skipIf(process.platform !== "linux")(
  "enforces both address-space limits before any producer allocation",
  async () => {
    const directory = await createTestTempDirectory("rea-sigrok-limits-");
    const command = join(directory, "memory-probe");
    await writeFile(
      command,
      `#!/usr/bin/python3
import resource, sys
assert resource.getrlimit(resource.RLIMIT_AS) == (1073741824, 1073741824)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (67108864, 67108864)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
if '--version' in sys.argv:
    print('sigrok-cli 0.7.2\\nlibsigrokdecode (resource fixture)')
else:
    try:
        bytearray(1073741825)
    except MemoryError:
        print('allocation refused by kernel limit')
    else:
        raise RuntimeError('allocation unexpectedly succeeded')
`,
      { mode: 0o700 },
    );
    const path = join(directory, "recording.vcd");
    await writeFile(path, "selected fixture");
    const service = new SignalRecordingService(
      new SigrokRecordingProvider({
        ...process.env,
        REA_SIGROK_COMMAND: command,
      }),
    );
    onTestFinished(() => service.close());
    const result = await service.decode({ path, decoders: "uart" });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      annotations_text: "allocation refused by kernel limit\n",
      limits: { address_space_bytes: 1073741824 },
    });
  },
);
