import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import {
  clientSkillDirectories,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
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

const dshClient = (
  env: Parameters<typeof supportedClients>[2],
  platform: NodeJS.Platform = "linux",
) =>
  supportedClients(join("/home/a"), platform, env).find(
    ({ name }) => name === "dsh",
  );

describe("DeepSeek Harness configuration paths", () => {
  it("resolves the home Cordis patch under the Harness home", () => {
    expect(dshClient({})).toEqual({
      name: "dsh",
      displayName: "DeepSeek Harness",
      configPath: join("/home/a", ".dsh", "cordis.patch.yml"),
      markerPath: join("/home/a", ".dsh"),
      format: "dsh",
    });
    // The home patch applies to every profile; DSH_HOME relocates it.
    expect(dshClient({ DSH_HOME: "/custom/harness" })?.configPath).toBe(
      join("/custom/harness", "cordis.patch.yml"),
    );
    expect(
      clientSkillDirectories(join("/home/a"), ["dsh"], {
        DSH_AGENTS_HOME: "/custom/agents",
      }),
    ).toEqual([{ client: "dsh", directory: join("/custom/agents", "skills") }]);
  });
});

const harnessClient = async () => {
  const home = await createTestTempDirectory("rea-dsh-");
  const client = supportedClients(home, process.platform, {}).find(
    ({ name }) => name === "dsh",
  );
  if (client?.markerPath === undefined)
    throw new Error("missing DeepSeek Harness client");
  await mkdir(client.markerPath, { recursive: true });
  return { home, client };
};

describe("DeepSeek Harness Cordis patch registration", () => {
  it("appends the rea-mcp insert, preserves user patches, and reads back", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `# Harness home patch
- insert:
    - id: user-tool
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: other
        transport: stdio
        command: other-server
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# Harness home patch");
    expect(parseYaml(text)).toEqual([
      {
        insert: [
          {
            id: "user-tool",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "other",
              transport: "stdio",
              command: "other-server",
            },
          },
        ],
      },
      {
        insert: [
          {
            id: "rea-mcp",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "rea",
              transport: "stdio",
              command: command[0],
              args: command.slice(1),
            },
          },
        ],
      },
    ]);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "aligned", command });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(parseYaml(await readFile(client.configPath, "utf8"))).toEqual([
      {
        insert: [
          {
            id: "user-tool",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "other",
              transport: "stdio",
              command: "other-server",
            },
          },
        ],
      },
    ]);
  });

  it("replaces an existing rea-mcp entry without duplicating it", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(
      await readFile(client.configPath, "utf8"),
    ) as unknown[];
    expect(patches).toHaveLength(1);
    expect((patches[0] as { insert: unknown[] }).insert).toHaveLength(1);
    expect(textOf(await readFile(client.configPath, "utf8"))).not.toContain(
      "stale-launcher",
    );
  });

  it("rewrites a wrong-package rea-mcp entry into the canonical one", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: not-the-harness-client
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          GHIDRA_INSTALL_DIR: /caller/nondefault/ghidra
`,
    );

    // The non-canonical entry reads back as stale, so setup rewrites it with
    // the canonical package name rather than reporting unchanged, and the
    // row's configured environment survives the identity repair.
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: { id: string; name: string; config?: { env?: unknown } }[];
    }[];
    expect(patches).toHaveLength(1);
    expect(patches[0]?.insert).toHaveLength(1);
    expect(patches[0]?.insert[0]?.id).toBe("rea-mcp");
    expect(patches[0]?.insert[0]?.name).toBe("@deepseek-ai/dsh-mcp-client");
    expect(patches[0]?.insert[0]?.config?.env).toEqual({
      GHIDRA_INSTALL_DIR: "/caller/nondefault/ghidra",
    });
    expect(textOf(await readFile(client.configPath, "utf8"))).not.toContain(
      "not-the-harness-client",
    );
  });
});

describe("DeepSeek Harness registration identity", () => {
  it("applies a direct config patch before judging the registration", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
- id: rea-mcp
  config:
    serverName: rea
    transport: stdio
    command: redirected-launcher
    args: [mcp]
`,
    );

    // The later direct patch replaces the row's config, so the effective
    // command is the redirect and the registration is stale, not aligned.
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "stale" });

    // Setup rewrites one canonical entry and drops the superseded direct op.
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).not.toContain("redirected-launcher");
    expect(text).not.toMatch(/^- id: rea-mcp$/mu);
    const patches = parseYaml(text) as unknown[];
    expect(patches).toHaveLength(1);
  });

  it("collapses duplicate rea entries into one canonical row", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: first-launcher
        args: [mcp]
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: second-launcher
        args: [mcp]
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: unknown[];
    }[];
    const reaRows = patches.flatMap(({ insert }) =>
      insert.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { id?: unknown }).id === "rea-mcp",
      ),
    );
    expect(reaRows).toHaveLength(1);
  });

  it("reports a foreign server name as stale instead of aligned", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: other
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
`,
    );

    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "stale" });
  });

  it("creates the patch list for an absent file and empties it on uninstall", async () => {
    const { home, client } = await harnessClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const created = parseYaml(
      await readFile(client.configPath, "utf8"),
    ) as unknown[];
    expect(created).toEqual([
      {
        insert: [
          {
            id: "rea-mcp",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "rea",
              transport: "stdio",
              command: command[0],
              args: command.slice(1),
            },
          },
        ],
      },
    ]);
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(await readFile(client.configPath, "utf8")).toBe("[]\n");
  });
});

describe("DeepSeek Harness repair boundaries", () => {
  it("repairs a direct-only registration by appending the insert", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- id: rea-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: rea
    transport: stdio
    command: stale-launcher
    args: [mcp]
`,
    );

    // An incomplete manual registration has no insertion to rewrite, so the
    // repair appends one canonical row instead of leaving the entry absent.
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(parseYaml(await readFile(client.configPath, "utf8"))).toEqual([
      {
        insert: [
          {
            id: "rea-mcp",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "rea",
              transport: "stdio",
              command: command[0],
              args: command.slice(1),
            },
          },
        ],
      },
    ]);
  });

  it("updates a grouped entry in place and drops the superseding disable op", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `# agent group carrying several tools
- id: agent-group
  insert:
    - id: user-tool
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: other
        transport: stdio
        command: other-server
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
- id: rea-mcp
  disabled: true
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# agent group carrying several tools");
    expect(text).not.toMatch(/^- id: rea-mcp$/mu);
    // The entry keeps its position inside the group; nothing moves to a new
    // root-level insertion.
    expect(parseYaml(text)).toEqual([
      {
        id: "agent-group",
        insert: [
          {
            id: "user-tool",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "other",
              transport: "stdio",
              command: "other-server",
            },
          },
          {
            id: "rea-mcp",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "rea",
              transport: "stdio",
              command: command[0],
              args: command.slice(1),
            },
          },
        ],
      },
    ]);
  });
});

describe("DeepSeek Harness registration state", () => {
  it("diagnoses a disabled entry as stale and re-enables it on repair", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      disabled: true
      config:
        serverName: rea
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
`,
    );

    // The command matches, but Cordis never activates a disabled row, so the
    // registration reads as stale rather than aligned.
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "stale" });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: { disabled?: unknown }[];
    }[];
    expect(patches[0]?.insert[0]?.disabled).toBeUndefined();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("retains the existing registration environment across a repair", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          GHIDRA_INSTALL_DIR: /caller/nondefault/ghidra
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: { config: { env?: Record<string, string> } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.env).toEqual({
      GHIDRA_INSTALL_DIR: "/caller/nondefault/ghidra",
    });
  });

  it("treats a direct-only registration as absent even when its config matches", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- id: rea-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: rea
    transport: stdio
    command: ${command[0]}
    args: [${command.slice(1).join(", ")}]
`,
    );

    // A direct patch needs an inserted row to target; with none, Harness has
    // no entry, so the registration is absent rather than aligned.
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "missing" });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: unknown[];
    }[];
    expect(patches).toHaveLength(1);
    expect(patches[0]?.insert).toHaveLength(1);
  });

  it("keeps caller-owned config fields across a refresh", async () => {
    const { client } = await harnessClient();
    const withCwd = (text: string): string =>
      text.replace("args: [mcp]", "args: [mcp]\n        cwd: /custom/workdir");
    await writeFile(
      client.configPath,
      withCwd(`- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
`),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: { config: { cwd?: unknown; command?: unknown } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.cwd).toBe("/custom/workdir");
    expect(patches[0]?.insert[0]?.config.command).toBe(command[0]);

    // An otherwise-matching row with caller fields is current, not stale.
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });
});

describe("DeepSeek Harness canonical row repair", () => {
  it("normalizes two aligned insertions instead of reporting unchanged", async () => {
    const { home, client } = await harnessClient();
    const row = `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
`;
    await writeFile(client.configPath, `${row}${row}`);

    // Both rows already match, but Cordis still has two insertions. Doctor
    // and setup must normalize to the single owned row.
    const registration = async () =>
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh");
    expect(await registration()).toMatchObject({ state: "stale" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert: unknown[];
    }[];
    const reaRows = patches.flatMap(({ insert }) =>
      insert.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { id?: unknown }).id === "rea-mcp",
      ),
    );
    expect(reaRows).toHaveLength(1);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect(await registration()).toMatchObject({ state: "aligned" });
  });

  it("keeps Cordis expression tags on caller-owned config fields", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        cwd: !!js process.cwd() # caller launch directory
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.cwd()");
    expect(text).toContain("# caller launch directory");
    expect(text).not.toContain("stale-launcher");
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert: { config: { cwd?: unknown; command?: unknown } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.command).toBe(command[0]);
    expect(patches[0]?.insert[0]?.config.cwd).toBe("process.cwd()");

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect(await readFile(client.configPath, "utf8")).toContain(
      "!!js process.cwd()",
    );
  });

  it("keeps a Cordis tag from the direct patch that owns the effective config", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: first-launcher
        args: [mcp]
- id: rea-mcp
  config:
    serverName: rea
    transport: stdio
    command: stale-launcher
    args: [mcp]
    cwd: !!js process.cwd()
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.cwd()");
    expect(text).not.toContain("stale-launcher");
    expect(text).not.toContain("first-launcher");
    expect(text).not.toMatch(/^- id: rea-mcp$/mu);
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert?: { config?: { cwd?: unknown } }[];
    }[];
    expect(patches).toHaveLength(1);
    expect(patches[0]?.insert?.[0]?.config?.cwd).toBe("process.cwd()");
  });
});

describe("DeepSeek Harness document edges", () => {
  it("keeps Cordis tags on environment values that were not overridden", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          OTHER: !!js process.env.OTHER
          TOKEN: !!js process.env.TOKEN # caller token
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.env.TOKEN");
    expect(text).toContain("# caller token");
    expect(text).toContain("!!js process.env.OTHER");
    expect(text).not.toContain("stale-launcher");
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert: { config: { env?: Record<string, string>; command?: string } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.command).toBe(command[0]);
    expect(patches[0]?.insert[0]?.config.env).toEqual({
      OTHER: "process.env.OTHER",
      TOKEN: "process.env.TOKEN",
    });

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect(await readFile(client.configPath, "utf8")).toContain(
      "!!js process.env.TOKEN",
    );
  });

  it("replaces only the environment entry a caller overrode", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          OTHER: !!js process.env.OTHER
          TOKEN: !!js process.env.TOKEN
`,
    );

    expect(
      (
        await configureClientConfiguration(
          client,
          { TOKEN: "literal-override" },
          command,
        )
      ).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.env.OTHER");
    expect(text).not.toContain("!!js process.env.TOKEN");
    expect(text).toContain("literal-override");
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert: { config: { env?: Record<string, string> } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.env).toEqual({
      OTHER: "process.env.OTHER",
      TOKEN: "literal-override",
    });
  });

  it("appends a registration to a comment-only patch file", async () => {
    const { home, client } = await harnessClient();
    const notes = "# harness notes\n# keep me\n";
    await writeFile(client.configPath, notes);

    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "missing" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# harness notes");
    expect(text).toContain("# keep me");
    expect(text).toContain("id: rea-mcp");
    expect(text).not.toMatch(/^null$/mu);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = await readFile(client.configPath, "utf8");
    expect(removed).toContain("# harness notes");
    expect(removed).toContain("# keep me");
    expect(removed).not.toContain("rea-mcp");
    expect(removed).not.toMatch(/^null$/mu);
  });
});

describe("DeepSeek Harness entry ownership", () => {
  const registration = async (home: string) =>
    (
      await readClientRegistrationStatuses(home, undefined, {
        platform: process.platform,
        environment: {},
      })
    ).find(({ client: name }) => name === "dsh");

  it("removes a stale launcher and a direct-only row by entry id", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: other-tool
      name: other
      config:
        command: keep-me
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
`,
    );

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = await readFile(client.configPath, "utf8");
    expect(removed).toContain("other-tool");
    expect(removed).not.toContain("rea-mcp");
    expect(removed).not.toContain("stale-launcher");

    await writeFile(
      client.configPath,
      `- id: other-tool
  config:
    command: keep-me
- id: rea-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config: {}
`,
    );
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const direct = await readFile(client.configPath, "utf8");
    expect(direct).toContain("other-tool");
    expect(direct).not.toContain("rea-mcp");
  });

  it("treats an expression disabled state as stale and clears it", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      disabled: !!js process.env.DISABLE_REA === "1"
      config:
        serverName: rea
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
`,
    );

    expect(await registration(home)).toMatchObject({ state: "stale" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).not.toContain("DISABLE_REA");
    expect(text).not.toContain("disabled:");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect(await registration(home)).toMatchObject({ state: "aligned" });
  });

  it("keeps a Cordis expression on a known environment setting", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          GHIDRA_INSTALL_DIR: !!js process.env.GHIDRA_INSTALL_DIR
`,
    );

    // The expression is not a literal path, so doctor can still classify the
    // row instead of rejecting the file.
    expect(await registration(home)).toMatchObject({ state: "stale" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.env.GHIDRA_INSTALL_DIR");
    expect(text).not.toContain("stale-launcher");
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert: { config: { env?: Record<string, string> } }[];
    }[];
    expect(patches[0]?.insert[0]?.config.env).toEqual({
      GHIDRA_INSTALL_DIR: "process.env.GHIDRA_INSTALL_DIR",
    });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    expect(await readFile(client.configPath, "utf8")).toContain(
      "!!js process.env.GHIDRA_INSTALL_DIR",
    );
  });
});

describe("DeepSeek Harness alias collapse", () => {
  it("collapses an aliased insertion and keeps an unrelated alias", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &other
  insert:
    - id: other-tool
      name: other
      config:
        command: keep-me
- *other
- &row
  insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
- *row
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("*other");
    expect(text).not.toContain("*row");
    expect(text).not.toContain("stale-launcher");
    const patches = parseYaml(text) as { insert?: { id?: string }[] }[];
    const reaRows = patches.flatMap(({ insert }) =>
      (insert ?? []).filter((entry) => entry.id === "rea-mcp"),
    );
    expect(reaRows).toHaveLength(1);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("collapses an aliased entry inside one insertion", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert:
    - &entry
      id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
    - *entry
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).not.toContain("*entry");
    const patches = parseYaml(text) as { insert?: { id?: string }[] }[];
    expect(
      patches.flatMap(({ insert }) =>
        (insert ?? []).filter((entry) => entry.id === "rea-mcp"),
      ),
    ).toHaveLength(1);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });
});

describe("DeepSeek Harness alias targets", () => {
  it("collapses an alias of the insert list", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert: &rows
    - id: other-tool
      name: other
      config:
        command: keep-me
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
- insert: *rows
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("other-tool");
    expect(text).not.toContain("*rows");
    expect(text).not.toContain("stale-launcher");
    const patches = parseYaml(text) as { insert?: { id?: string }[] }[];
    expect(
      patches.flatMap(({ insert }) =>
        (insert ?? []).filter((entry) => entry.id === "rea-mcp"),
      ),
    ).toHaveLength(1);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("keeps a Cordis tag when the config map is an alias", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &cfg
  cwd: !!js process.cwd() # caller launch directory
  serverName: rea
  transport: stdio
  command: stale-launcher
  args: [mcp]
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config: *cfg
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.cwd()");
    expect(text).toContain("# caller launch directory");
    const patches = parseYaml(text, { logLevel: "error" }) as {
      insert?: { config?: { cwd?: unknown; command?: unknown } }[];
    }[];
    const row = patches.find((patch) => patch.insert !== undefined);
    expect(row?.insert?.[0]?.config?.cwd).toBe("process.cwd()");
    expect(row?.insert?.[0]?.config?.command).toBe(command[0]);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });
});

describe("DeepSeek Harness alias identity", () => {
  it("keeps unrelated rows when the insert list is anchored outside an operation", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &rows
  - id: other-tool
    name: other
    config:
      command: keep-me
  - id: rea-mcp
    name: "@deepseek-ai/dsh-mcp-client"
    config:
      serverName: rea
      transport: stdio
      command: stale-launcher
      args: [mcp]
- insert: *rows
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert?: { id?: string; config?: { command?: string } }[];
    }[];
    const inserted = patches.flatMap((patch) => patch.insert ?? []);
    expect(inserted.filter((entry) => entry.id === "other-tool")).toHaveLength(
      1,
    );
    expect(inserted.filter((entry) => entry.id === "rea-mcp")).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({ command: command[0] }),
      }),
    ]);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("keeps an aliased Cordis tag on an environment value", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &expr !!js process.env.TOKEN
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          TOKEN: *expr
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.env.TOKEN");
    expect(text).toContain("*expr");
    expect(text).not.toContain("stale-launcher");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("recognizes an aliased entry id", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &entryId rea-mcp
- insert:
    - id: *entryId
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const patches = parseYaml(await readFile(client.configPath, "utf8")) as {
      insert?: { id?: string }[];
    }[];
    expect(
      patches.flatMap((patch) =>
        (patch.insert ?? []).filter((entry) => entry.id === "rea-mcp"),
      ),
    ).toHaveLength(1);
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(await readFile(client.configPath, "utf8")).not.toContain("*entryId");
  });
});

describe("DeepSeek Harness alias cleanup", () => {
  it("keeps tags when the environment map is an alias", async () => {
    const { client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &reaEnv
  TOKEN: !!js process.env.TOKEN
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env: *reaEnv
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("!!js process.env.TOKEN");
    expect(text).not.toContain("stale-launcher");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  });

  it("does not validate an aliased Cordis path expression as a literal", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- &expr !!js process.env.GHIDRA_INSTALL_DIR
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: stale-launcher
        args: [mcp]
        env:
          GHIDRA_INSTALL_DIR: *expr
`,
    );

    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "dsh"),
    ).toMatchObject({ state: "stale" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await readFile(client.configPath, "utf8")).toContain(
      "!!js process.env.GHIDRA_INSTALL_DIR",
    );
  });

  it("removes an aliased insert list on uninstall", async () => {
    const { home, client } = await harnessClient();
    await writeFile(
      client.configPath,
      `- insert: &rows
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: ${command[0]}
        args: [${command.slice(1).join(", ")}]
- insert: *rows
`,
    );

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const text = await readFile(client.configPath, "utf8");
    expect(text).not.toContain("rea-mcp");
    expect(text).not.toContain("*rows");
  });
});

const textOf = (value: unknown): string => String(value);
