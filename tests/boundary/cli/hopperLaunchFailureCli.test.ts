import { chmod, copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, onTestFinished } from "vitest";
import { z } from "zod";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

import { HOPPER_TARGET_LEASE_DIRECTORY } from "../../../src/hopper/HopperTargetLease.js";

const FAILED_LAUNCHER = `#!/bin/sh
printf 'Cannot launch Hopper!\\nNot authorized to send Apple events to Hopper Disassembler.\\n' >&2
exit 2
`;

/** The private runtime directory a failed launch reports as retained. */
const RetainedRuntime = z.object({
  details: z.object({
    diagnostics: z.object({
      cleanup_error: z.object({
        details: z.object({
          diagnostics: z.object({ runtime_root: z.string() }),
        }),
      }),
    }),
  }),
});

const listLeases = async (): Promise<ReadonlySet<string>> =>
  new Set(await readdir(HOPPER_TARGET_LEASE_DIRECTORY).catch(() => []));

describe("Hopper launcher failure through the one-shot CLI", () => {
  // Hopper target leases are acquired only for the macOS launcher route.
  workspaceCliTest.skipIf(process.platform !== "darwin")(
    "exits after a retained-cleanup failure and releases the target to a retry",
    async ({ cli, workspace }) => {
      const launcherPath = await workspace.write(
        "failure-helper",
        FAILED_LAUNCHER,
      );
      await chmod(launcherPath, 0o700);
      const targetPath = workspace.path("probe");
      await copyFile("/usr/bin/true", targetPath);
      const leasesBefore = await listLeases();
      onTestFinished(async () => {
        for (const name of await listLeases())
          if (!leasesBefore.has(name))
            await rm(join(HOPPER_TARGET_LEASE_DIRECTORY, name), {
              force: true,
            });
      });

      for (const attempt of ["first", "retry"]) {
        const result = await cli.run({
          arguments: ["analyze", targetPath, "--provider", "hopper", "--json"],
          environment: {
            ...workspace.environment,
            HOPPER_LAUNCHER_PATH: launcherPath,
            REA_LOG_LEVEL: "silent",
          },
          timeoutMs: 30_000,
        });
        const retained = RetainedRuntime.safeParse(result.json);
        if (retained.success)
          await rm(
            retained.data.details.diagnostics.cleanup_error.details.diagnostics
              .runtime_root,
            { recursive: true, force: true },
          );

        expect(result.exitCode, attempt).toBe(1);
        expect(result.json, attempt).toMatchObject({
          code: "cleanup_incomplete",
          details: {
            cleanup: "incomplete",
            diagnostics: {
              primary_error: {
                code: "provider_unavailable",
                details: {
                  stage: "launch",
                  launcher: {
                    exit_code: 2,
                    stderr: {
                      text: expect.stringContaining(
                        "Not authorized to send Apple events",
                      ),
                    },
                  },
                },
              },
            },
          },
        });
      }
    },
  );
});
