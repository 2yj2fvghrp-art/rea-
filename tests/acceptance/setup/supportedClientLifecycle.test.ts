import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sweepEnvironment = (home: string) =>
  ({
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    NODE_COMPILE_CACHE: undefined,
  }) as NodeJS.ProcessEnv;

// Sweep membership only depends on the platform and the presence of the
// platform variables above, so a virtual home is enough to enumerate cases.
const sweepClientNames = supportedClients(
  join("rea-client-lifecycle-sweep", "home"),
  process.platform,
  sweepEnvironment(join("rea-client-lifecycle-sweep", "home")),
)
  .filter(
    (client) =>
      client.format !== "unsupported" &&
      client.configPathError === undefined &&
      client.markerPath !== undefined,
  )
  .map((client) => client.name);

for (const name of sweepClientNames)
  cliTest(
    `setup, doctor and uninstall stay symmetric for ${name}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-client-lifecycle-");
      const environment = sweepEnvironment(home);
      const client = supportedClients(home, process.platform, environment).find(
        (candidate) => candidate.name === name,
      );
      if (client?.markerPath === undefined)
        throw new Error(`client ${name} is not sweepable on this platform`);
      await mkdir(client.markerPath, { recursive: true });

      const setup = await cli.run({
        arguments: ["setup", "--client", name, "--yes", "--json"],
        cwd: home,
        environment,
        timeoutMs: 60_000,
      });
      expect(setup.exitCode).toBe(0);

      const doctor = await cli.run({
        arguments: ["doctor", "--json"],
        cwd: home,
        environment,
        timeoutMs: 60_000,
      });
      const registrations = ((
        doctor.json as { identity?: { registrations?: unknown[] } } | undefined
      )?.identity?.registrations ?? []) as Array<{
        client: string;
        state: string;
      }>;
      const row = registrations.find((entry) => entry.client === name);
      expect(row?.state).toBe("aligned");

      const configured = await readFile(client.configPath, "utf8");
      const rerun = await cli.run({
        arguments: ["setup", "--client", name, "--yes", "--json"],
        cwd: home,
        environment,
        timeoutMs: 60_000,
      });
      expect(rerun.exitCode).toBe(0);
      expect(await readFile(client.configPath, "utf8")).toBe(configured);

      const uninstall = await cli.run({
        arguments: ["uninstall", "--json"],
        cwd: home,
        environment,
        timeoutMs: 60_000,
      });
      expect(uninstall.exitCode).toBe(0);
      const remaining = await readFile(client.configPath, "utf8");
      expect(remaining.includes('"rea"')).toBe(false);
      expect(remaining.includes(".rea")).toBe(false);
      for (const destination of skillDestinations(home, [name], environment)) {
        await expect(
          readFile(join(destination.path, "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
