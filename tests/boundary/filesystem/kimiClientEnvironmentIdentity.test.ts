import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import { clientRegistrationEnvironment } from "../../../src/application/ClientRegistrationEnvironment.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = npxRegistrationCommand("win32");

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

describe("Kimi Code environment-key identity", () => {
  it("keeps one env key for a case-variant explicit profile on Windows", () => {
    const merged = clientRegistrationEnvironment(
      parseClientConfiguration(
        JSON.stringify({
          mcpServers: {
            rea: {
              command: command[0],
              args: command.slice(1),
              env: { rea_mcp_input_schema_profile: "full" },
            },
          },
        }),
        "json",
      ),
      {},
      { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
      "win32",
    );
    if (!merged.ok) throw merged.error;
    expect(merged.value).toEqual({ rea_mcp_input_schema_profile: "full" });
  });

  it("reads a case-variant explicit profile as aligned on Windows", async () => {
    const home = await createTestTempDirectory("rea-kimi-");
    const client = supportedClients(home, process.platform, {}).find(
      ({ name }) => name === "kimi_code",
    );
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
            env: { rea_mcp_input_schema_profile: "full" },
          },
        },
      }),
    );
    const status = (
      await readClientRegistrationStatuses(home, resolve("scripts/rea.mjs"), {
        environment: {},
        platform: "win32",
      })
    ).find(({ client: name }) => name === "kimi_code");
    expect(status).toMatchObject({ state: "aligned" });
  });
});
