import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

type CliInstance = ReturnType<typeof createCli>;

const serve = async (
  cli: CliInstance,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

describe("inspect-recorded-crash advertised path description", () => {
  it("names both decoded core architectures", async () => {
    const cli = createCli({});
    const schema = await serve(cli, [
      "inspect-recorded-crash",
      "--schema",
      "--json",
    ]);
    expect(schema.exitCode).toBe(0);
    const parsed = JSON.parse(schema.stdout) as {
      readonly args?: {
        readonly properties?: Record<string, { readonly description?: string }>;
      };
    };
    const description = parsed.args?.properties?.path?.description;
    // The decoder interprets both RECORDED_LINUX_CORE_ARCHITECTURES
    // profiles, so the advertised contract must not drop AArch64.
    expect(description).toContain("amd64");
    expect(description).toContain("AArch64");
  });
});
