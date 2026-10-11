import { access, readFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";

import {
  assertDeobfuscationCleanup,
  deobfuscationFixture,
} from "../../../tests/fixtures/javascript-deobfuscation/provider.js";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "publishes source, proof report and safe rewritten JavaScript through the owned-process boundary",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
      max_iterations: 16,
    });
    if (!response.ok) throw response.error;
    expect(response.value).toMatchObject({
      operation: "deobfuscate_javascript_source",
      provider: { id: "js-redox", version: "0.1.0" },
      normalized_result: {
        status: "changed",
        runtime_execution: "not-performed",
        proof: {
          schema: "js-safe-deobfuscate/v1",
          transforms: { static_array_lookup: 2, constant_fold: 1 },
          runtime_semantics_preserved_by_design: true,
        },
      },
    });
    await expect(
      readFile(`${fixture.output}/deobfuscated/source.js`, "utf8"),
    ).resolves.toContain('console.log("hello world")');
    await expect(
      access(`${fixture.output}/manifest.json`),
    ).resolves.toBeUndefined();
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "rejects a proof report whose output digest does not match published bytes",
  async () => {
    const fixture = await deobfuscationFixture("bad-digest");
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected proof mismatch");
    expect(response.error._tag).toBe("AnalysisOutputError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);
