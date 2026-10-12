/**
 * Security Regression Tests — Platform-Verified Reproductions
 *
 * Addresses maintainer review findings:
 *   P2 — Bootstrap cleanup on ALL cancelled launch paths (finally block)
 *   P3 — Platform-aware path normalization for Windows
 */
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HopperApplicationLauncher } from "./BridgeLauncher.js";
import type { BridgeSession } from "./BridgeLauncher.js";

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers — real filesystem, zero mocks
// ────────────────────────────────────────────────────────────────────────────

const directories: string[] = [];
const isWindows = process.platform === "win32";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-security-poc-"));
  directories.push(directory);
  return directory;
};

// ────────────────────────────────────────────────────────────────────────────
// P2 — Bootstrap cleanup on all cancelled launch paths
// ────────────────────────────────────────────────────────────────────────────

describe("P2: Bootstrap file cleanup on every non-success path", () => {
  it("launch failure cleans up bootstrap.py (finally block, not catch-only)", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");
    const session: BridgeSession = {
      directory,
      socketPath: join(directory, "bridge.sock"),
      token: "test_token_for_cleanup_verification",
      runId: "test-session-cleanup",
    };

    const launcher = new HopperApplicationLauncher(
      {
        environment: process.env,
        launcherPath: join(directory, "nonexistent-hopper-binary"),
        targetPath: join(directory, "test-binary"),
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: join(directory, "bridge.py"),
        launchMode: "native",
      },
      {
        platform: "darwin",
        acquireTargetLease: async () => ({
          acquired: true as const,
          lease: { release: async () => {} },
        }),
      },
    );

    const result = await launcher.launch(session);
    expect(result.ok).toBe(false);

    // Bootstrap must be removed by the finally block
    let fileExists: boolean;
    try {
      await stat(bootstrapPath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it("cancelled launch (aborted signal) cleans up bootstrap.py", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");
    const controller = new AbortController();
    controller.abort(); // Pre-abort to trigger the signal?.aborted path

    const session: BridgeSession = {
      directory,
      socketPath: join(directory, "bridge.sock"),
      token: "cancelled_token",
      runId: "test-session-cancel",
    };

    const launcher = new HopperApplicationLauncher(
      {
        environment: process.env,
        launcherPath: join(directory, "nonexistent"),
        targetPath: join(directory, "test-binary"),
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: join(directory, "bridge.py"),
        launchMode: "native",
      },
      {
        platform: "darwin",
        acquireTargetLease: async () => ({
          acquired: true as const,
          lease: { release: async () => {} },
        }),
      },
    );

    const result = await launcher.launch(session, {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);

    // The signal?.aborted return (L210) previously bypassed catch cleanup.
    // With the finally block, bootstrap.py is removed on this path too.
    let fileExists: boolean;
    try {
      await stat(bootstrapPath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it("rm({ force: true }) is idempotent (safe on missing files)", async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, "does-not-exist.py");
    await expect(
      rm(missing, { force: true }).catch(() => undefined),
    ).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P3 — Platform-aware path normalization for Windows
// ────────────────────────────────────────────────────────────────────────────

describe("P3: Windows path normalization preserves junction detection", () => {
  it("O_NOFOLLOW is undefined on Windows, non-zero on POSIX", () => {
    const value = fsConstants.O_NOFOLLOW;
    if (isWindows) {
      expect(value).toBeUndefined();
    } else {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  it("WINDOWS: junction causes realpath divergence after resolve+normalize", async () => {
    if (!isWindows) return;

    const directory = await temporaryDirectory();
    const realDir = join(directory, "real");
    const junctionDir = join(directory, "junction");

    await mkdir(realDir);
    const secretFile = join(realDir, "secret.txt");
    await writeFile(secretFile, "confidential data");

    await symlink(realDir, junctionDir, "junction");

    const throughJunction = join(junctionDir, "secret.txt");
    const canonical = await realpath(throughJunction);

    // Even after resolve(), the junction path still diverges
    const resolvedRequest = resolve(throughJunction);
    const resolvedCanonical = resolve(canonical);

    // Case-insensitive compare still detects the junction
    const diverged =
      resolvedCanonical.localeCompare(resolvedRequest, undefined, {
        sensitivity: "accent",
      }) !== 0;
    expect(diverged).toBe(true);
  });

  it("WINDOWS: same file with different casing does NOT false-positive", async () => {
    if (!isWindows) return;

    const directory = await temporaryDirectory();
    const file = join(directory, "TestFile.txt");
    await writeFile(file, "content");

    // Access with different casing
    const lowercase = join(directory, "testfile.txt");
    const rpOriginal = resolve(await realpath(file));
    const rpLower = resolve(await realpath(lowercase));

    // Case-insensitive compare treats these as SAME (no false omission)
    const diverged =
      rpOriginal.localeCompare(rpLower, undefined, {
        sensitivity: "accent",
      }) !== 0;
    expect(diverged).toBe(false);
  });

  it("POSIX: hashFile rejects symlink-substituted files", async () => {
    if (isWindows) return;

    const { hashFile } =
      await import("../process/capture/FilesystemSnapshot.js");
    const directory = await temporaryDirectory();
    const observedFile = join(directory, "app.exe");
    const secretFile = join(directory, "secret.docx");

    await writeFile(observedFile, "original binary\n");
    await writeFile(secretFile, "TOP SECRET\n");

    const originalStats = await lstat(observedFile);
    await rm(observedFile);
    await symlink(secretFile, observedFile);

    const result = await hashFile(observedFile, originalStats, 100_000);
    expect(result.state).toBe("omitted");
    expect(result).not.toHaveProperty("sha256");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lease directory hardening (unchanged from prior review)
// ────────────────────────────────────────────────────────────────────────────

describe("Lease directory validation (POSIX-only)", () => {
  it("mkdir(recursive:true) silently ignores existing directory permissions", async () => {
    if (isWindows) return;

    const directory = await temporaryDirectory();
    const leaseDir = join(directory, "rea-hopper-1000");
    await mkdir(leaseDir, { mode: 0o755 });
    await mkdir(leaseDir, { recursive: true, mode: 0o700 });

    const after = await lstat(leaseDir);
    expect(after.mode & 0o777).toBe(0o755);
    expect(after.mode & 0o077).not.toBe(0);
  });

  it("symlink at lease path redirects socket files to attacker directory", async () => {
    if (isWindows) return;

    const directory = await temporaryDirectory();
    const attackerDir = join(directory, "attacker");
    const victimDir = join(directory, "rea-hopper-1000");

    await mkdir(attackerDir, { mode: 0o755 });
    await symlink(attackerDir, victimDir);

    await writeFile(join(victimDir, "lease.sock"), "socket data");
    const attackerFiles = await readdir(attackerDir);
    expect(attackerFiles).toContain("lease.sock");
  });

  it("O_NOFOLLOW rejects symlinks at kernel level", async () => {
    if (isWindows) return;
    if (
      typeof fsConstants.O_NOFOLLOW !== "number" ||
      fsConstants.O_NOFOLLOW === 0
    )
      return;

    const directory = await temporaryDirectory();
    const realDir = join(directory, "real");
    const symlinkDir = join(directory, "symlink");

    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, symlinkDir);

    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      fsConstants.O_NOFOLLOW;

    await expect(open(symlinkDir, flags)).rejects.toMatchObject({
      code: "ELOOP",
    });

    const handle = await open(realDir, flags);
    expect((await handle.stat()).isDirectory()).toBe(true);
    await handle.close();
  });

  it("fstat on descriptor is immune to path-level swap", async () => {
    if (isWindows) return;

    const directory = await temporaryDirectory();
    const leaseDir = join(directory, "lease");
    await mkdir(leaseDir, { mode: 0o700 });

    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(leaseDir, flags);
    const originalIno = (await handle.stat()).ino;

    await rm(leaseDir, { recursive: true });
    await mkdir(leaseDir, { mode: 0o755 });

    expect((await handle.stat()).ino).toBe(originalIno);
    expect((await lstat(leaseDir)).ino).not.toBe(originalIno);

    await handle.close();
  });
});
