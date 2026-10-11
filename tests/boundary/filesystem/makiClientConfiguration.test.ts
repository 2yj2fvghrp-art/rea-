import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
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

const makiPath = (
  env: Parameters<typeof supportedClients>[2],
  platform: NodeJS.Platform = "linux",
  home = "/home/a",
) => supportedClients(home, platform, env).find(({ name }) => name === "maki");

describe("Maki configuration paths", () => {
  it("resolves mcp.toml under the platform config directory", () => {
    expect(makiPath({})).toEqual({
      name: "maki",
      displayName: "Maki",
      configPath: join("/home/a", ".config", "maki", "mcp.toml"),
      // The inactive legacy file is tracked for cleanup only, never read.
      cleanupPaths: [join("/home/a", ".maki", "mcp.toml")],
      markerPath: join("/home/a", ".config", "maki"),
      format: "maki",
    });
    expect(makiPath({ XDG_CONFIG_HOME: "/custom/config" })?.configPath).toBe(
      join("/custom/config", "maki", "mcp.toml"),
    );
    // An empty or relative XDG_CONFIG_HOME is unset, not a relative working
    // directory, matching etcetera and the XDG spec.
    for (const value of ["", "cfg"])
      expect(makiPath({ XDG_CONFIG_HOME: value })?.configPath).toBe(
        join("/home/a", ".config", "maki", "mcp.toml"),
      );
    // Maki's base strategy uses XDG on macOS, not Application Support.
    expect(makiPath({}, "darwin")?.configPath).toBe(
      join("/home/a", ".config", "maki", "mcp.toml"),
    );
    // Maki uses %APPDATA%\maki on Windows.
    expect(
      makiPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")
        ?.configPath,
    ).toBe(join("C:\\Users\\a\\AppData\\Roaming", "maki", "mcp.toml"));
  });

  it("collapses to the legacy ~/.maki directory when it exists", async () => {
    const home = await createTestTempDirectory("rea-maki-legacy-");
    await mkdir(join(home, ".maki"), { recursive: true });
    expect(makiPath({}, "linux", home)).toMatchObject({
      configPath: join(home, ".maki", "mcp.toml"),
      markerPath: join(home, ".maki"),
      // The inactive platform file is tracked for cleanup only.
      cleanupPaths: [join(home, ".config", "maki", "mcp.toml")],
    });
  });

  it("uninstalls an REA entry from both the platform and legacy locations", async () => {
    const home = await createTestTempDirectory("rea-maki-both-");
    await mkdir(join(home, ".maki"), { recursive: true });
    await mkdir(join(home, ".config", "maki"), { recursive: true });
    const legacy = join(home, ".maki", "mcp.toml");
    const platform = join(home, ".config", "maki", "mcp.toml");
    const entry = `[mcp.rea]\ncommand = [${command.map((part) => JSON.stringify(part)).join(", ")}]\n`;
    await writeFile(legacy, entry);
    await writeFile(platform, entry);

    // Pin Linux so the platform location is `~/.config/maki` on every host.
    const host = systemUninstallHost(home, undefined, {}, "linux");
    const makiClients = (await host.clients()).filter(
      ({ name }) => name === "maki",
    );
    // One entry per tracked location, so an older platform entry cannot
    // become active again if ~/.maki is later removed.
    expect(makiClients).toHaveLength(2);
    for (const client of makiClients)
      expect((await host.removeClient(client)).status).toBe("removed");
    expect(parseToml(await readFile(legacy, "utf8"))).not.toHaveProperty(
      "mcp.rea",
    );
    expect(parseToml(await readFile(platform, "utf8"))).not.toHaveProperty(
      "mcp.rea",
    );
  });
});

describe("Maki TOML registration", () => {
  const makiClient = async () => {
    const home = await createTestTempDirectory("rea-maki-");
    const client = supportedClients(home, process.platform, {}).find(
      ({ name }) => name === "maki",
    );
    if (client?.markerPath === undefined)
      throw new Error("missing Maki client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("writes [mcp.rea], preserves comments and settings, reads back, uninstalls", async () => {
    const { home, client } = await makiClient();
    await writeFile(
      client.configPath,
      `# Maki MCP servers.
defer_tools = 30

# An independently managed server.
[mcp.other]
command = ["other-server"]
always_load = true
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# Maki MCP servers.");
    expect(text).toContain("# An independently managed server.");
    expect(parseToml(text)).toMatchObject({
      defer_tools: 30,
      mcp: {
        other: { command: ["other-server"], always_load: true },
        rea: { command: [...command] },
      },
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
      ).find(({ client: name }) => name === "maki"),
    ).toMatchObject({ state: "aligned", command });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(parseToml(await readFile(client.configPath, "utf8"))).toMatchObject({
      defer_tools: 30,
      mcp: { other: { command: ["other-server"], always_load: true } },
    });
  });

  it("keeps the comment introducing the REA table and round-trips environment", async () => {
    const { home, client } = await makiClient();
    await writeFile(
      client.configPath,
      `# REA settings stay here.
[mcp.rea]
command = ["old-binary", "mcp"]
`,
    );
    const environment = { REA_LOG_LEVEL: "silent" };
    expect(
      (await configureClientConfiguration(client, environment, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# REA settings stay here.");
    expect(parseToml(text)).toMatchObject({
      mcp: {
        rea: {
          command: [...command],
          environment: { REA_LOG_LEVEL: "silent" },
        },
      },
    });
    // Reconfiguring with the same environment is a no-op.
    expect(
      await configureClientConfiguration(client, environment, command),
    ).toEqual({ status: "unchanged" });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
  });

  it("does not read an inactive location for doctor status", async () => {
    const home = await createTestTempDirectory("rea-maki-inactive-");
    await mkdir(join(home, ".maki"), { recursive: true });
    await mkdir(join(home, ".config", "maki"), { recursive: true });
    // Maki reads only the legacy file, which has no REA entry.
    await writeFile(
      join(home, ".maki", "mcp.toml"),
      `[mcp.other]\ncommand = ["other-server"]\n`,
    );
    // The inactive platform file still holds an old REA entry; it must not
    // surface as an aligned registration.
    await writeFile(
      join(home, ".config", "maki", "mcp.toml"),
      `[mcp.rea]\ncommand = [${command.map((part) => JSON.stringify(part)).join(", ")}]\n`,
    );
    const status = (
      await readClientRegistrationStatuses(home, undefined, {
        platform: "linux",
        environment: {},
      })
    ).find(({ client: name }) => name === "maki");
    expect(status).toMatchObject({ state: "missing" });
  });

  it("creates mcp.toml when Maki has no configuration yet", async () => {
    const { client } = await makiClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(parseToml(await readFile(client.configPath, "utf8"))).toEqual({
      mcp: { rea: { command: [...command] } },
    });
  });

  it("reports a non-REA or disabled rea registration accurately", async () => {
    const { home, client } = await makiClient();
    await writeFile(
      client.configPath,
      `[mcp.rea]
command = ["other-binary", "serve"]
enabled = false
`,
    );
    const status = async () =>
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "maki");
    // Not REA-owned, so doctor flags it rather than claiming it is aligned,
    // and uninstall leaves the foreign registration in place.
    expect(await status()).toMatchObject({ state: "stale" });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "retained",
    );
    // An owned but explicitly disabled entry is unaligned too.
    await writeFile(
      client.configPath,
      `[mcp.rea]\ncommand = [${command.map((part) => JSON.stringify(part)).join(", ")}]\nenabled = false\n`,
    );
    expect(await status()).toMatchObject({ state: "stale" });
  });
});
