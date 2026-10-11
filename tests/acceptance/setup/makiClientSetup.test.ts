import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parse as parseToml } from "smol-toml";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "setup writes [mcp.rea] for Maki, doctor aligns it, and unrelated settings survive",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-maki-cli-");
    const config = join(home, ".config", "maki", "mcp.toml");
    await mkdir(join(home, ".config", "maki"), { recursive: true });
    await writeFile(
      config,
      '# Keep this note.\ndefer_tools = 30\n\n[mcp.other]\ncommand = ["other-server"]\n',
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
    };

    const setup = await cli.run({
      arguments: [
        "setup",
        "--client",
        "maki",
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment,
      timeoutMs: 60_000,
    });
    expect(setup.exitCode).toBe(0);
    expect(setup.json).toMatchObject({ status: "ready" });

    const text = await readFile(config, "utf8");
    expect(text).toContain("# Keep this note.");
    const parsed = parseToml(text) as {
      defer_tools: number;
      mcp: Record<string, { command: string[] }>;
    };
    expect(parsed.defer_tools).toBe(30);
    expect(parsed.mcp.other).toEqual({ command: ["other-server"] });
    // The dev build registers its direct launcher; a packaged install registers
    // the pinned npx command. Either way the argv array ends in `mcp`.
    const reaCommand = parsed.mcp.rea?.command;
    expect(Array.isArray(reaCommand)).toBe(true);
    expect(reaCommand?.length).toBeGreaterThan(1);
    expect(reaCommand?.at(-1)).toBe("mcp");

    const doctor = await cli.run({
      arguments: ["doctor", "--client", "maki", "--json"],
      cwd: home,
      environment,
      timeoutMs: 60_000,
    });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "maki", state: "aligned" }),
        ]),
      },
    });
  },
);
