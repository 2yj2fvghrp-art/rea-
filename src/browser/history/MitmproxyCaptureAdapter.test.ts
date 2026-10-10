import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { MitmproxyCaptureAdapter } from "./MitmproxyCaptureAdapter.js";

const it = test.skipIf(process.platform !== "linux");

it("rejects a directory configured as the mitmdump executable", async () => {
  const root = await createTestTempDirectory("rea-mitmdump-command-");
  const command = join(root, "mitmdump");
  await mkdir(command);

  await expect(
    new MitmproxyCaptureAdapter({ REA_MITMDUMP_COMMAND: command }).command(
      join(root, "request.json"),
      join(root, "runtime"),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining(command),
  });
});
