import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  agentEvalEnvironment,
  prepareAgentEvalClient,
  selectAgentEvalClient,
} from "../../scripts/lib/agent-eval-clients.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["claude-code", "gemini-cli"])(
  "%s receives selected authentication and scenario-specific permissions",
  async (id) => {
    const root = await createTestTempDirectory("rea-agent-client-policy-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".gemini"), { recursive: true });
    await writeFile(
      join(caller, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", caller);
    vi.stubEnv("GEMINI_CLI_HOME", caller);
    vi.stubEnv("ANTHROPIC_API_KEY", "selected-claude-key");
    vi.stubEnv("GEMINI_API_KEY", "selected-gemini-key");
    vi.stubEnv("OPENAI_API_KEY", "foreign-openai-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "foreign-aws-key");
    const client = await prepareAgentEvalClient(selectAgentEvalClient(id), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths: [],
    });
    const environment = agentEvalEnvironment({
      account: join(root, "account"),
      runId: "test",
      client,
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).toHaveProperty(
      id === "claude-code" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY",
    );
    expect(environment).not.toHaveProperty(
      id === "claude-code" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY",
    );
    const permissions = async (approved: string[]) => {
      const args = await client.arguments("prompt", approved);
      if (id === "claude-code") {
        expect(args[args.indexOf("--tools") + 1]).toContain(
          "WaitForMcpServers",
        );
        const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
        expect(settings.permissions.allow).toContain("WaitForMcpServers");
        return settings.permissions.allow.join("\n");
      }
      return readFile(args[args.indexOf("--policy") + 1], "utf8");
    };
    const browser = await permissions(["list_browser_targets"]);
    expect(browser).toContain("list_browser_targets");
    expect(browser).not.toContain("capture_process_scenario");
    const ordinary = await permissions([]);
    expect(ordinary).not.toContain("list_browser_targets");
    expect(ordinary).not.toContain("capture_process_scenario");
    const preflight = agentEvalEnvironment({
      account: join(root, "account"),
      runId: "test",
      client: { environment: {} },
    });
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ])
      expect(preflight).not.toHaveProperty(key);
  },
);

it.each(["explicit", "empty"])(
  "keeps Gemini's selected keychain authentication with %s home instead of copying stale OAuth",
  async (override) => {
    const root = await createTestTempDirectory("rea-agent-gemini-auth-");
    const caller = join(root, "caller");
    await mkdir(join(caller, ".gemini"), { recursive: true });
    await writeFile(
      join(caller, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    await writeFile(
      join(caller, ".gemini", "oauth_creds.json"),
      "stale-oauth-fixture",
    );
    vi.stubEnv("HOME", caller);
    vi.stubEnv("USERPROFILE", caller);
    vi.stubEnv("GEMINI_CLI_HOME", override === "empty" ? "" : caller);
    vi.stubEnv("GEMINI_API_KEY", undefined);
    const authPaths: string[] = [];
    await prepareAgentEvalClient(selectAgentEvalClient("gemini-cli"), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths,
    });
    expect(authPaths).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(root, "gemini-cli", ".gemini", "settings.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ security: { auth: { selectedType: "gemini-api-key" } } });
  },
);

it("publishes credential cleanup ownership before a failed copy rejects preparation", async () => {
  const root = await createTestTempDirectory("rea-agent-auth-ownership-");
  const caller = join(root, "caller");
  await mkdir(join(caller, "auth.json"), { recursive: true });
  vi.stubEnv("CODEX_HOME", caller);
  const authPaths: string[] = [];
  await expect(
    prepareAgentEvalClient(selectAgentEvalClient("codex"), {
      evaluationRoot: root,
      account: join(root, "account"),
      authPaths,
    }),
  ).rejects.toThrow();
  expect(authPaths).toEqual([join(root, "codex", "auth.json")]);
});
