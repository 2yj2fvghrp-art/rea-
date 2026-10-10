import { access, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";

import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { createSqliteDatabaseFixture } from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const descriptorCleanup = vi.hoisted(() => ({
  path: "",
  denied: false,
  invalidate: false,
  attempts: 0,
  handles: [] as FileHandle[],
  readFailure: undefined as Error | undefined,
  onOpen: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      if (args[0] === descriptorCleanup.path) {
        descriptorCleanup.handles.push(handle);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          // FileHandle.close also asks attached streams to close the invalidated handle.
          if (handle.fd < 0) {
            await close();
            return;
          }
          descriptorCleanup.attempts += 1;
          if (descriptorCleanup.denied) {
            if (descriptorCleanup.invalidate) await close();
            throw new Error("injected SQLite descriptor close failure");
          }
          await close();
        };
        if (descriptorCleanup.readFailure !== undefined)
          vi.spyOn(handle, "stat").mockRejectedValue(
            descriptorCleanup.readFailure,
          );
        descriptorCleanup.onOpen?.();
      }
      return handle;
    },
  };
});

const fixture = async (
  member: "database" | "WAL" | "journal",
  invalidate = false,
) => {
  const workspace = await createTestWorkspace("rea-sqlite-descriptor-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root, true);
  const path =
    member === "database"
      ? database.path
      : member === "WAL"
        ? database.walPath
        : `${database.path}-journal`;
  if (member === "journal") await writeFile(path, Buffer.alloc(28));
  const roots: PrivateRuntimeRoot[] = [];
  const provider = new SqliteDatabaseProvider(
    {},
    () => {
      throw new Error("SQLite worker deliberately unavailable");
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      return root;
    },
  );
  descriptorCleanup.path = path;
  descriptorCleanup.denied = true;
  descriptorCleanup.invalidate = invalidate;
  descriptorCleanup.attempts = 0;
  descriptorCleanup.handles = [];
  descriptorCleanup.readFailure = undefined;
  descriptorCleanup.onOpen = undefined;
  onTestFinished(async () => {
    descriptorCleanup.denied = false;
    try {
      await provider.close();
    } catch (cause) {
      if (!invalidate) throw cause;
    }
    for (const handle of descriptorCleanup.handles) await handle.close();
    descriptorCleanup.path = "";
    database.close();
    await removeTestWorkspace(workspace.root);
  });
  return { provider, roots, path, database };
};

it.each(["database", "WAL", "journal"] as const)(
  "retains a failed %s descriptor and retries it at shutdown",
  async (member) => {
    const selected = await fixture(member);
    const first = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [expect.stringContaining(selected.path)],
      },
    });
    const handle = descriptorCleanup.handles[0];
    if (handle === undefined)
      throw new Error("Expected owned source descriptor");
    expect(handle.fd).toBeGreaterThanOrEqual(0);
    const blocked = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(selected.roots).toHaveLength(1);
    await expect(selected.provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(descriptorCleanup.attempts).toBe(3);
    descriptorCleanup.denied = false;
    await selected.provider.close();
    expect(descriptorCleanup.attempts).toBe(4);
    expect(handle.fd).toBe(-1);
    for (const root of selected.roots)
      await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("retries source cleanup before admitting another snapshot", async () => {
  const selected = await fixture("database");
  await selected.provider.inspect({ path: selected.database.path });
  const first = descriptorCleanup.handles[0];
  if (first === undefined) throw new Error("Expected source descriptor");
  descriptorCleanup.denied = false;
  const resumed = await selected.provider.inspect({
    path: selected.database.path,
  });
  expect(selected.roots).toHaveLength(2);
  expect(first.fd).toBe(-1);
  if (resumed.ok) throw new Error("The worker is deliberately unavailable");
  expect(resumed.error.cleanupIncomplete).toBe(false);
  await selected.provider.close();
});

it("keeps an invalidated descriptor close failure unconfirmed across retries", async () => {
  const selected = await fixture("journal", true);
  const first = await selected.provider.inspect({
    path: selected.database.path,
  });
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(descriptorCleanup.handles[0]?.fd).toBe(-1);
  descriptorCleanup.denied = false;
  await expect(selected.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  await expect(selected.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(descriptorCleanup.attempts).toBe(1);
});

it.each(["EACCES", "EPERM"])(
  "preserves %s read diagnostics alongside a failed descriptor close",
  async (code) => {
    const selected = await fixture("database");
    descriptorCleanup.readFailure = Object.assign(
      new Error("injected source read denial"),
      { code },
    );
    const result = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: { previous_error: { code: "access_denied" } },
      },
    });
  },
);

it.each(["database", "WAL", "journal"] as const)(
  "preserves caller cancellation alongside a failed %s descriptor close",
  async (member) => {
    const selected = await fixture(member);
    const controller = new AbortController();
    descriptorCleanup.onOpen = () =>
      controller.abort(new Error("requested caller cancellation"));
    const result = await selected.provider.inspect(
      { path: selected.database.path },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: { previous_error: { code: "cancelled" } },
      },
    });
  },
);
