import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const zcodePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "zcode");

describe("ZCode configuration paths", () => {
  it("resolves the user config file and marker directory", () => {
    expect(zcodePath("/home/a")).toEqual({
      name: "zcode",
      displayName: "ZCode",
      configPath: join("/home/a", ".zcode", "cli", "config.json"),
      markerPath: join("/home/a", ".zcode", "cli"),
      format: "zcode",
    });
    expect(zcodePath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".zcode", "cli", "config.json"),
    );
    expect(zcodePath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".zcode", "cli", "config.json"),
    );
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["zcode"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".zcode", "skills", "reverse-engineer-anything"),
    ]);
  });
});

const zcodeClient = async () => {
  const home = await createTestTempDirectory("rea-zcode-");
  const client = zcodePath(home, process.platform);
  if (client?.markerPath === undefined) throw new Error("missing ZCode client");
  await mkdir(client.markerPath, { recursive: true });
  return { home, client };
};

describe("ZCode JSON registration", () => {
  it("upserts rea into mcp.servers while preserving unrelated settings", async () => {
    const { home, client } = await zcodeClient();
    await writeFile(
      client.configPath,
      `{
  "mcp": {
    "servers": {
      "other": { "command": "other-server" }
    }
  }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "zcode"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcp.servers table in an existing config without servers", async () => {
    const { client } = await zcodeClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ ui: { theme: "dark" } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.ui).toEqual({ theme: "dark" });
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty config file", async () => {
    const { client } = await zcodeClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await zcodeClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcp: { servers: { other: { command: "other-server" } } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.mcp.servers.rea).toBeUndefined();
  });
});

describe("ZCode .agents fallback preservation", () => {
  const fallbackPath = (home: string) => join(home, ".agents", "mcp.json");

  it("migrates fallback servers the first native registration would suppress", async () => {
    const { home, client } = await zcodeClient();
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      fallbackPath(home),
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "other-server", env: { TOKEN: "x" } },
          },
        },
        null,
        2,
      ),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({
      command: "other-server",
      env: { TOKEN: "x" },
    });
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
    // The fallback file stays in place; ZCode ignores it from now on.
    expect(
      JSON.parse(await readFile(fallbackPath(home), "utf8")).mcpServers.other,
    ).toEqual({ command: "other-server", env: { TOKEN: "x" } });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
  });

  it("leaves an existing native table alone instead of merging the fallback", async () => {
    const { home, client } = await zcodeClient();
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      fallbackPath(home),
      JSON.stringify(
        { mcpServers: { shared: { command: "fallback-server" } } },
        null,
        2,
      ),
    );
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcp: { servers: { existing: { command: "existing-server" } } } },
        null,
        2,
      ),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.existing).toEqual({
      command: "existing-server",
    });
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
    expect(parsed.mcp.servers.shared).toBeUndefined();
  });

  it("fails closed when the fallback configuration is malformed", async () => {
    const { home, client } = await zcodeClient();
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(fallbackPath(home), "{ not json");

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "readback",
    });
    await expect(readFile(client.configPath, "utf8")).rejects.toThrow();
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      { status: "invalid" },
    );
  });

  it("fails closed when the fallback path is not a regular file", async () => {
    const { home, client } = await zcodeClient();
    await mkdir(fallbackPath(home), { recursive: true });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "readback",
    });
    await expect(readFile(client.configPath, "utf8")).rejects.toThrow();
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      { status: "invalid" },
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO fallback without blocking on it",
    async () => {
      const { home, client } = await zcodeClient();
      await mkdir(join(home, ".agents"), { recursive: true });
      await promisify(execFile)("mkfifo", [fallbackPath(home)]);

      expect(await configureClientConfiguration(client, {}, command)).toEqual({
        status: "failed",
        reason: "readback",
      });
      await expect(readFile(client.configPath, "utf8")).rejects.toThrow();
      expect(
        await inspectClientConfiguration(client, {}, command),
      ).toMatchObject({ status: "invalid" });
    },
  );
});

describe("ZCode disabled registrations", () => {
  it("reports enable: false as stale and repairs it on setup", async () => {
    const { home, client } = await zcodeClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        {
          mcp: {
            servers: {
              rea: {
                command: command[0],
                args: command.slice(1),
                enable: false,
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const statusFor = async () =>
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "zcode");
    expect(await statusFor()).toMatchObject({ state: "stale" });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await statusFor()).toMatchObject({ state: "aligned", command });
  });
});
