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

describe("inspect-analysis-view advertised description", () => {
  it("names the retained parent families the shared service supports", async () => {
    const cli = createCli({});
    // --schema reports only the argument schema; the command description is
    // advertised in its help.
    const help = await serve(cli, ["inspect-analysis-view", "--help"]);
    expect(help.exitCode).toBe(0);
    const description = help.stdout.split("\n")[0];
    // The shared view service projects web network capture and pcap parents
    // alongside the original three; the help must not hide them.
    expect(description).toContain("web network capture");
    expect(description).toContain("pcap");
  });
});
