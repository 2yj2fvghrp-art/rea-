import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createPeResourcesService } from "../../../src/composition/binaryDiagnostics.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
import { peResourceFixture } from "../../../src/native/pe/PeResources.fixture.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const busy = vi.hoisted(() => ({ path: "" }));

// Node opens files with full sharing, so a test process cannot hold one without read sharing
// itself. This injects the error Windows returns for that sharing violation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      if (busy.path !== "" && args[0] === busy.path)
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, open '${busy.path}'`),
          { code: "EBUSY", errno: -4082, syscall: "open", path: busy.path },
        );
      return filesystem.open(...args);
    },
  };
});

const expectRetryableBusyTarget = (
  error: Parameters<typeof projectAnalysisError>[0],
  path: string,
) => {
  expect(error).toMatchObject({
    _tag: "BinaryTargetError",
    path,
    constraint: "target_in_use",
  });
  expect(projectAnalysisError(error)).toMatchObject({
    code: "target_unavailable",
    category: "unavailable",
    retryable: true,
    message:
      "The selected target is held open by another process without read sharing. Close that application or select a copy, then retry.",
    details: { path, constraint: "target_in_use" },
  });
};

const expectRetryableBusyPeImage = (
  error: Parameters<typeof projectAnalysisError>[0],
  path: string,
) =>
  expect(projectAnalysisError(error)).toMatchObject({
    code: "capability_unavailable",
    category: "unavailable",
    retryable: true,
    message:
      "The selected PE image is held open by another process without read sharing. Close that application or inspect a copy, then retry.",
    details: {
      provider_id: "rea-pe-resources",
      operation: "inspect_pe_resources",
      reason: `Selected PE image is in use by another process (EBUSY): ${path}`,
    },
  });

const stopHolder = async (holder: ChildProcess) => {
  // A holder that never started has no pid and emits only "error", never "exit".
  if (
    holder.pid === undefined ||
    holder.exitCode !== null ||
    holder.signalCode !== null
  )
    return;
  const exited = new Promise<void>((resolve) =>
    holder.once("exit", () => resolve()),
  );
  holder.kill();
  await exited;
};

/** Hold the file open from another Windows process without read sharing. */
const holdWithoutSharing = async (path: string): Promise<ChildProcess> => {
  const literal = path.replaceAll("'", "''");
  const holder = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$f = [System.IO.File]::Open('${literal}', 'Open', 'ReadWrite', 'None'); Write-Output ready; Start-Sleep -Seconds 60; $f.Close()`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  await new Promise<void>((resolve, reject) => {
    holder.stdout?.once("data", () => resolve());
    holder.once("error", (error) =>
      reject(new Error("Holder did not start", { cause: error })),
    );
    holder.once("exit", (code) =>
      reject(
        new Error(`Holder exited before opening the file (${String(code)})`),
      ),
    );
  });
  return holder;
};

it("reports a selected target held by another process as retryable and unavailable", async () => {
  const workspace = await createTestWorkspace("rea-target-busy-");
  const path = join(workspace.root, "busy.exe");
  await writeFile(path, pe(0x8664));
  onTestFinished(async () => {
    busy.path = "";
    await removeTestWorkspace(workspace.root);
  });
  busy.path = path;

  const result = await parseBinaryTarget(path, { cwd: workspace.root });
  if (result.ok) throw new Error("Expected a busy target rejection");
  expectRetryableBusyTarget(result.error, path);

  busy.path = "";
  expect((await parseBinaryTarget(path, { cwd: workspace.root })).ok).toBe(
    true,
  );
});

it("reports a selected PE image held by another process as retryable and unavailable", async () => {
  const workspace = await createTestWorkspace("rea-pe-resources-busy-");
  const path = join(workspace.root, "busy.exe");
  await writeFile(path, peResourceFixture().bytes);
  const service = createPeResourcesService();
  onTestFinished(async () => {
    busy.path = "";
    await service.close();
    await removeTestWorkspace(workspace.root);
  });
  busy.path = path;

  const result = await service.inspect({ path });
  if (result.ok) throw new Error("Expected a busy PE image rejection");
  expectRetryableBusyPeImage(result.error, path);

  busy.path = "";
  expect((await service.inspect({ path })).ok).toBe(true);
});

it.runIf(process.platform === "win32")(
  "reports targets that another Windows process holds without sharing as retryable",
  async () => {
    const workspace = await createTestWorkspace("rea-target-busy-native-");
    const target = join(workspace.root, "target.exe");
    const image = join(workspace.root, "image.exe");
    await writeFile(target, pe(0x8664));
    await writeFile(image, peResourceFixture().bytes);
    const service = createPeResourcesService();
    const holders: ChildProcess[] = [];
    // One ordered cleanup: the holders must release the files before the workspace is removed.
    onTestFinished(async () => {
      await Promise.all(holders.map(stopHolder));
      await service.close();
      await removeTestWorkspace(workspace.root);
    });
    holders.push(await holdWithoutSharing(target));
    holders.push(await holdWithoutSharing(image));

    const resolved = await parseBinaryTarget(target, { cwd: workspace.root });
    if (resolved.ok) throw new Error("Expected a busy target rejection");
    expectRetryableBusyTarget(resolved.error, target);

    const inspected = await service.inspect({ path: image });
    if (inspected.ok) throw new Error("Expected a busy PE image rejection");
    expectRetryableBusyPeImage(inspected.error, image);
  },
  20_000,
);
