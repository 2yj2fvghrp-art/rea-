import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";

const roots: string[] = [];
beforeEach(clearClientLocationEnvironment);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const readWorkBuddyConfig = async (
  home: string,
): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(join(home, ".workbuddy", "mcp.json"), "utf8"),
  ) as Record<string, unknown>;

describe("WorkBuddy client configuration", () => {
  it("registers rea in the top-level mcpServers table of ~/.workbuddy/mcp.json", async () => {
    const home = await createTestTempDirectory("rea-workbuddy-");
    roots.push(home);
    const configPath = join(home, ".workbuddy", "mcp.json");
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{}}');

    const result = await configureClientConfiguration(
      { name: "workbuddy", configPath, format: "json" },
      {
        HOPPER_LAUNCHER_PATH: "/Hopper Path",
        GHIDRA_INSTALL_DIR: "/opt/ghidra",
        JAVA_HOME: "/opt/jdk-21",
      },
      ["/abs/path/to/rea.mjs", "mcp"],
    );
    expect(result).toMatchObject({ status: "configured" });

    const config = await readWorkBuddyConfig(home);
    const rea = (config.mcpServers as Record<string, unknown>).rea as Record<
      string,
      unknown
    >;
    expect(rea).toBeDefined();
    expect(rea.command).toBe("/abs/path/to/rea.mjs");
    expect(rea.args).toEqual(["mcp"]);
    expect((rea.env as Record<string, string>).GHIDRA_INSTALL_DIR).toBe(
      "/opt/ghidra",
    );
    expect((rea.env as Record<string, string>).JAVA_HOME).toBe("/opt/jdk-21");
  });

  it("preserves unrelated servers and formatting when adding rea", async () => {
    const home = await createTestTempDirectory("rea-workbuddy-keep-");
    roots.push(home);
    const configPath = join(home, ".workbuddy", "mcp.json");
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "already-there": {
            command: "/usr/bin/other",
            args: ["serve"],
            env: {},
          },
        },
      }),
    );

    expect(
      await configureClientConfiguration(
        { name: "workbuddy", configPath, format: "json" },
        undefined,
        ["/abs/path/to/rea.mjs", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });

    const config = await readWorkBuddyConfig(home);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers["already-there"]).toEqual({
      command: "/usr/bin/other",
      args: ["serve"],
      env: {},
    });
    expect((servers.rea as Record<string, unknown>).command).toBe(
      "/abs/path/to/rea.mjs",
    );
  });

  it("is idempotent: a second run reports unchanged and rewrites nothing", async () => {
    const home = await createTestTempDirectory("rea-workbuddy-idem-");
    roots.push(home);
    const configPath = join(home, ".workbuddy", "mcp.json");
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{}}');

    const env = {
      HOPPER_LAUNCHER_PATH: "/Hopper Path",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/opt/jdk-21",
    };
    const command = ["/abs/path/to/rea.mjs", "mcp"];
    expect(
      await configureClientConfiguration(
        { name: "workbuddy", configPath, format: "json" },
        env,
        command,
      ),
    ).toMatchObject({ status: "configured" });

    const first = await readFile(configPath, "utf8");
    expect(
      await configureClientConfiguration(
        { name: "workbuddy", configPath, format: "json" },
        env,
        command,
      ),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(first);
  });
});
