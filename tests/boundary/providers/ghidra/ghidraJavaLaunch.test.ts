import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createGhidraDiagnostics } from "../../../../src/ghidra/GhidraDiagnostics.js";
import {
  GhidraHeadlessLauncher,
  GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
  type GhidraLaunchSession,
} from "../../../../src/ghidra/GhidraLauncher.js";
import { bindGhidraSessionFailure } from "../../../../src/ghidra/GhidraSessionError.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";

const warning =
  "[0.004s][warning][os,container] Cgroup limits may be inaccurate: /tmp/password-fixture?token=public-value";

const fixture = async (mode: string) => {
  const root = await createTestTempDirectory("rea-ghidra-java-launch-");
  const javaHome = join(root, "jdk");
  await mkdir(join(javaHome, "bin"), { recursive: true });
  await writeFile(
    join(javaHome, "bin", "java"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const probe = args.at(-1);
if (probe !== "-envvars" && probe !== "-vmargs") process.exit(64);
const mode = ${JSON.stringify(mode)};
const warning = ${JSON.stringify(warning)};
const stream = args.includes("-Xlog:disable") && args.includes("-Xlog:all=warning:stderr") ? process.stderr : process.stdout;
if (mode !== "quiet") stream.write(probe + ": " + warning + "\\n");
if (mode === "credential") stream.write("explicit credential: private-transport-token\\n");
if (mode === "large") stream.write("é".repeat(${GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES}) + "UNRETAINED-TAIL\\n");
if (mode === "env-failure" || (probe === "-vmargs" && mode === "vm-failure")) {
  process.stderr.write("failed " + probe + "\\n");
  process.exitCode = 3;
} else if (probe === "-envvars") {
  process.stdout.write(mode === "env-malformed" ? "invalid environment\\n" : "GHIDRA_MAXMEM=1G\\n");
} else {
  process.stdout.write(mode === "vm-malformed" ? "invalid JVM argument\\n" : "-Dfile.encoding=UTF8\\n");
}
`,
    { mode: 0o755 },
  );
  const session: GhidraLaunchSession = {
    runtimeRoot: join(root, "runtime"),
    transport: "unix-socket",
    endpointPath: join(root, "endpoint.sock"),
    token: "private-transport-token",
    runId: randomUUID(),
    targetPath: join(root, "target.bin"),
    targetSha256: "0".repeat(64),
    providerVersion: "test",
    profileDigest: "test",
  };
  const analysisArguments: (readonly string[])[] = [];
  const controller = new AbortController();
  const launcher = new GhidraHeadlessLauncher({
    environment: { PATH: process.env.PATH ?? "" },
    platform: process.platform,
    javaHome,
    analyzeHeadlessPath: join(root, "ghidra", "support", "analyzeHeadless"),
    bridgeScriptPath: join(root, "ReaGhidraBridge.java"),
    spawnProcess: async (options) => {
      analysisArguments.push(options.arguments);
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        expectedCommand: process.execPath,
      });
      onTestFinished(async () => {
        const cleanup =
          spawned.cleanup === undefined
            ? await cleanupOwnedProcessGroup(spawned.ownership)
            : await spawned.cleanup();
        expect(cleanup.cleaned).toBe(true);
      });
      if (mode === "cancel-after-spawn") controller.abort();
      return spawned;
    },
  });
  return { session, launcher, analysisArguments, controller };
};

describe.skipIf(process.platform === "win32")(
  "Ghidra LaunchSupport diagnostics",
  () => {
    it("preserves both redirected warnings while keeping the analysis JVM arguments clean", async () => {
      const { session, launcher, analysisArguments } = await fixture("success");
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      expect(analysisArguments[0]).toContain("-Dfile.encoding=UTF8");
      expect(analysisArguments[0]).toContain("-Xmx1G");
      expect(
        analysisArguments[0]?.some(
          (argument) =>
            argument.startsWith("-Xlog:") || argument.includes("[warning]"),
        ),
      ).toBe(false);
      const diagnostics = createGhidraDiagnostics({
        targetPath: session.targetPath,
        targetSha256: session.targetSha256,
        transport: session.transport,
        providerVersion: session.providerVersion,
        profileDigest: session.profileDigest,
        launch: launched.value,
        token: session.token,
        previous: {},
      });
      expect(diagnostics.launch_support).toEqual(
        ["-envvars", "-vmargs"].map((mode) => ({
          mode,
          stderr: `${mode}: ${warning}\n`,
          stderr_bytes: Buffer.byteLength(`${mode}: ${warning}\n`),
          stderr_truncated: false,
        })),
      );
    });

    it.each(["env-failure", "vm-failure", "env-malformed", "vm-malformed"])(
      "retains helper warnings through session failure diagnostics after %s",
      async (mode) => {
        const { session, launcher, analysisArguments } = await fixture(mode);
        const launched = await launcher.launch(session);
        expect(launched.ok).toBe(false);
        if (launched.ok) throw new Error("Expected a helper failure");
        expect(analysisArguments).toEqual([]);
        const failure = bindGhidraSessionFailure(() => ({}))(
          "start",
          launched.error.message,
          launched.error,
        );
        const cause = failure.diagnostics.failure_cause;
        if (mode === "env-failure") {
          expect(cause).toMatchObject({
            launch_outcome: {
              exit_code: 3,
              stderr: expect.stringContaining(`-envvars: ${warning}`),
            },
          });
        } else {
          expect(cause).toMatchObject({
            launch_support: expect.arrayContaining([
              expect.objectContaining({
                mode: "-envvars",
                stderr: `-envvars: ${warning}\n`,
              }),
            ]),
          });
        }
        if (mode === "vm-failure")
          expect(cause).toMatchObject({
            launch_outcome: {
              exit_code: 3,
              stderr: expect.stringContaining(`-vmargs: ${warning}`),
            },
          });
        if (mode === "vm-malformed")
          expect(cause).toMatchObject({
            launch_support: expect.arrayContaining([
              expect.objectContaining({
                mode: "-vmargs",
                stderr: `-vmargs: ${warning}\n`,
              }),
            ]),
          });
      },
    );

    it("bounds retained UTF-8 warnings and reports original byte counts", async () => {
      const { session, launcher } = await fixture("large");
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      for (const output of launched.value.launchSupport ?? []) {
        expect(output.stderr_truncated).toBe(true);
        expect(output.stderr_bytes).toBeGreaterThan(
          GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
        );
        expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(
          GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
        );
        expect(output.stderr).not.toContain("UNRETAINED-TAIL");
        expect(output.stderr).not.toContain("�");
      }
      expect(launched.value.launchSupport).toHaveLength(2);
    });

    it("omits helper diagnostics when both stderr streams are empty", async () => {
      const { session, launcher } = await fixture("quiet");
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      expect(launched.value.launchSupport).toBeUndefined();
    });

    it("redacts the explicit transport credential and preserves caller-selected paths and URL values", async () => {
      const { session, launcher } = await fixture("credential");
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      expect(launched.value.launchSupport).toHaveLength(2);
      for (const output of launched.value.launchSupport ?? []) {
        expect(output.stderr).toContain(warning);
        expect(output.stderr).toContain("explicit credential: [REDACTED]");
        expect(output.stderr).not.toContain(session.token);
        expect(output.stderr_truncated).toBe(false);
      }
    });

    it("preserves completed helper warnings when startup is cancelled after process creation", async () => {
      const { session, launcher, controller } =
        await fixture("cancel-after-spawn");
      const launched = await launcher.launch(session, {
        signal: controller.signal,
      });
      expect(launched.ok).toBe(false);
      if (launched.ok) throw new Error("Expected cancellation");
      const failure = bindGhidraSessionFailure(() => ({}))(
        "cancelled",
        launched.error.message,
        launched.error,
      );
      expect(failure.diagnostics.failure_cause).toMatchObject({
        cause: {
          launch_support: expect.arrayContaining([
            expect.objectContaining({
              mode: "-envvars",
              stderr: `-envvars: ${warning}\n`,
            }),
            expect.objectContaining({
              mode: "-vmargs",
              stderr: `-vmargs: ${warning}\n`,
            }),
          ]),
        },
      });
    });
  },
);
