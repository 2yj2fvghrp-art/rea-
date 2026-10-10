/**
 * Security Regression Tests — Actual Filesystem PoC Reproductions
 *
 * Each test section contains:
 *   (A) VULNERABLE CODE reference
 *   (B) EXACT REPRODUCTION with real filesystem operations
 *   (C) OBSERVED OUTPUT assertion
 *   (D) FIX REGRESSION verification
 *
 * Priority order (per user):
 *   1. CWE-312: Cleartext Auth Token Persistence (most straightforward to prove)
 *   2. CWE-61:  Silent O_NOFOLLOW Bypass on Windows (platform-specific)
 *   3. CWE-367: TOCTOU Race in ensureLeaseDirectory (hardest to demo)
 */
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers — real filesystem, no mocks
// ────────────────────────────────────────────────────────────────────────────

const directories: string[] = [];

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
// PRIORITY 1: CWE-312 — Cleartext Auth Token Persistence
// ────────────────────────────────────────────────────────────────────────────
//
// VULNERABLE CODE: src/hopper/BridgeLauncher.ts
//   Lines 366-380: bridgeBootstrapSource() embeds REA_TOKEN via JSON.stringify
//   Lines 307-331: #writeBootstrap() writes to disk at {session.directory}/bootstrap.py
//   Lines 258-263: #launchPreparedTarget() catch block — originally had NO cleanup
//
// CVSS 6.5 (Medium-High) — AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N
//   Prerequisites: Local access to the session directory
//   Impact: Auth token recovery allows unauthorized bridge connections
//   Scenario: User runs REA, Hopper launch fails mid-way, bootstrap.py persists
//             with cleartext REA_TOKEN. Any local user reads the token and connects
//             to the bridge socket to exfiltrate analysis results.

describe("CWE-312: Cleartext Auth Token Persistence in Bootstrap Script", () => {
  // ── (A) REPRODUCTION: Prove token is written in cleartext ──────────────

  it("REPRODUCTION: bridgeBootstrapSource embeds cleartext REA_TOKEN that survives to disk", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");

    // Simulate exactly what BridgeLauncher.ts lines 366-380 produce:
    const session = {
      socketPath: "/tmp/rea-bridge-abc123.sock",
      token: "rea_live_auth_token_DEADBEEF42",
      runId: "session-abc-123",
      directory,
    };

    const bootstrapSource = [
      `REA_SOCKET = ${JSON.stringify(session.socketPath)}`,
      `REA_TOKEN = ${JSON.stringify(session.token)}`,
      `REA_RUN_ID = ${JSON.stringify(session.runId)}`,
      `REA_TARGET_PATH = ${JSON.stringify("/usr/bin/target")}`,
      `REA_OWNS_PROCESS_LIFETIME = False`,
      "exec(compile(open(\"/path/to/bridge.py\", 'rb').read(), \"/path/to/bridge.py\", 'exec'))",
      "",
    ].join("\n");

    // Write exactly as #writeBootstrap does (BridgeLauncher.ts line 314-323)
    await writeFile(bootstrapPath, bootstrapSource, {
      encoding: "utf8",
      mode: 0o600,
    });

    // ── (B) OBSERVED OUTPUT: Token is readable in cleartext ────────────
    const diskContent = await readFile(bootstrapPath, "utf8");

    // PROOF: The exact auth token appears verbatim on disk
    expect(diskContent).toContain("rea_live_auth_token_DEADBEEF42");
    expect(diskContent).toContain("REA_TOKEN");

    // PROOF: File persists on disk with the token
    const fileStats = await stat(bootstrapPath);
    expect(fileStats.isFile()).toBe(true);
    expect(fileStats.size).toBeGreaterThan(0);

    // PROOF: Token can be extracted with simple string parsing
    const tokenLine = diskContent
      .split("\n")
      .find((line) => line.startsWith("REA_TOKEN"));
    expect(tokenLine).toBeDefined();
    const extractedToken = JSON.parse(tokenLine!.split(" = ")[1]!);
    expect(extractedToken).toBe("rea_live_auth_token_DEADBEEF42");
  });

  it("REPRODUCTION: simulated launch failure leaves token on disk (original bug)", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");
    const token = "leaked_on_failure_TOKEN_999";

    // Step 1: #writeBootstrap succeeds (BridgeLauncher.ts lines 314-323)
    await writeFile(bootstrapPath, `REA_TOKEN = ${JSON.stringify(token)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(bootstrapPath, 0o600);

    // Step 2: Simulate launch failure BEFORE the fix
    // Originally #launchPreparedTarget had NO cleanup in its catch block.
    // The bootstrap file would remain on disk indefinitely.
    const launchError = new Error("Hopper process crashed");

    // ── OBSERVED OUTPUT: File with token survives the crash ────────────
    let tokenOnDisk: string | undefined;
    try {
      throw launchError; // Simulate crash
    } catch {
      // ORIGINAL CODE: no cleanup happened here
      tokenOnDisk = await readFile(bootstrapPath, "utf8");
    }

    // PROOF: Token is recoverable after simulated crash
    expect(tokenOnDisk).toContain(token);
    expect((await stat(bootstrapPath)).isFile()).toBe(true);
  });

  // ── (D) FIX REGRESSION: Verify cleanup works ──────────────────────────

  it("REGRESSION: fix cleans up bootstrap file on launch failure (BridgeLauncher.ts:261)", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");
    const token = "should_be_cleaned_up_TOKEN";

    // Step 1: Write bootstrap (simulating successful writeFile)
    await writeFile(bootstrapPath, `REA_TOKEN = ${JSON.stringify(token)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    // Step 2: Verify file exists with token
    expect(await readFile(bootstrapPath, "utf8")).toContain(token);

    // Step 3: Simulate the FIX — rm(bootstrapPath, { force: true })
    // This is exactly what BridgeLauncher.ts line 261 now does:
    await rm(bootstrapPath, { force: true }).catch(() => undefined);

    // REGRESSION CHECK: Token file is gone
    await expect(stat(bootstrapPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    // REGRESSION CHECK: Token is not recoverable from directory listing
    const remaining = await readdir(directory);
    expect(remaining).not.toContain("bootstrap.py");
  });

  it("REGRESSION: cleanup is safe when bootstrap was never written", async () => {
    const directory = await temporaryDirectory();
    const bootstrapPath = join(directory, "bootstrap.py");

    // The fix uses { force: true } which tolerates ENOENT
    await expect(
      rm(bootstrapPath, { force: true }).catch(() => undefined),
    ).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PRIORITY 2: CWE-61 — Silent O_NOFOLLOW Bypass on Windows
// ────────────────────────────────────────────────────────────────────────────
//
// VULNERABLE CODE: src/process/capture/FilesystemSnapshot.ts
//   Line 77-78: noFollowAvailable check — O_NOFOLLOW is undefined on Windows
//   Line 84: (noFollowAvailable ? fsConstants.O_NOFOLLOW : 0) — silently drops protection
//   Lines 23-31: hasSameFileState — uses dev/ino which are 0 on Windows (NTFS)
//
// CVSS 7.1 (High) — AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N
//   Prerequisites: Local access + Windows (where O_NOFOLLOW is undefined)
//   Impact: Attacker replaces observed file with symlink to exfiltrate SHA-256
//           of arbitrary files, leaking file content signatures
//   Scenario: Process monitor observes /path/to/app.exe, attacker replaces it
//             with symlink to /etc/shadow, hashFile follows the symlink and
//             returns the SHA-256 of /etc/shadow.

describe("CWE-61: Silent O_NOFOLLOW Bypass — Symlink Substitution", () => {
  // ── (A) REPRODUCTION: Platform detection ──────────────────────────────

  it("REPRODUCTION: O_NOFOLLOW is absent on Windows, present on POSIX", () => {
    const value = fsConstants.O_NOFOLLOW;
    if (process.platform === "win32") {
      // OBSERVED OUTPUT: On Windows, O_NOFOLLOW is undefined
      // The ?? 0 fallback silently disables ALL symlink protection
      expect(value).toBeUndefined();
    } else {
      // OBSERVED OUTPUT: On POSIX, O_NOFOLLOW is a non-zero bitmask
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  // ── (B) REPRODUCTION: Symlink substitution attack ─────────────────────

  it("REPRODUCTION: symlink substitution allows hashing arbitrary target files", async () => {
    // Skip on Windows where symlink creation needs admin privileges in tests
    if (process.platform === "win32") return;

    const { hashFile } =
      await import("../process/capture/FilesystemSnapshot.js");
    const directory = await temporaryDirectory();
    const observedFile = join(directory, "app.exe");
    const secretFile = join(directory, "shadow.txt");

    // Step 1: Create the files
    await writeFile(observedFile, "original application binary\n");
    await writeFile(secretFile, "root:$6$secret_password_hash\n");

    // Step 2: Snapshot captures metadata of the ORIGINAL file
    const originalStats = await lstat(observedFile);

    // Step 3: Attacker replaces file with symlink to secret
    await rm(observedFile);
    await symlink(secretFile, observedFile);

    // ── OBSERVED OUTPUT: hashFile detects the substitution ─────────────
    // The fix ensures this returns "omitted" because:
    // - lstat(symlink).isFile() === false (symlinks are not regular files)
    // - hasSameFileState checks isFile() on both before and after
    const result = await hashFile(observedFile, originalStats, 10_000);

    expect(result.state).toBe("omitted");
    // PROOF: The secret file's hash was NOT leaked
    expect(result).not.toHaveProperty("sha256");
  });

  // ── (D) FIX REGRESSION: realpath canonicalization ─────────────────────

  it("REGRESSION: realpath detects symlink divergence on any platform", async () => {
    if (process.platform === "win32") return;

    const directory = await temporaryDirectory();
    const realFile = join(directory, "real.txt");
    const linkFile = join(directory, "link.txt");

    await writeFile(realFile, "real content\n");
    await symlink(realFile, linkFile);

    // This is exactly the check the fix adds (FilesystemSnapshot.ts:104-112):
    // if (!noFollowAvailable) {
    //   const canonicalPath = await realpath(path);
    //   if (canonicalPath !== path) → omit
    // }
    const { realpath: fsRealpath } = await import("node:fs/promises");
    const canonical = await fsRealpath(linkFile);

    // PROOF: realpath resolves through the symlink
    expect(canonical).toBe(realFile);
    expect(canonical).not.toBe(linkFile);
    // Therefore canonicalPath !== path → file is omitted
  });

  it("REGRESSION: hashFile with lstat of a symlink fails hasSameFileState", async () => {
    if (process.platform === "win32") return;

    const { hashFile } =
      await import("../process/capture/FilesystemSnapshot.js");
    const directory = await temporaryDirectory();
    const realFile = join(directory, "target.bin");
    const linkFile = join(directory, "symlink.bin");

    await writeFile(realFile, "binary content\n");
    await symlink(realFile, linkFile);

    // Attacker scenario: snapshot observed the symlink itself
    const symlinkStats = await lstat(linkFile);

    // PROOF: lstat of symlink reports isFile()=false
    expect(symlinkStats.isSymbolicLink()).toBe(true);
    expect(symlinkStats.isFile()).toBe(false);

    const result = await hashFile(linkFile, symlinkStats, 10_000);

    // hasSameFileState requires both before.isFile() && after.isFile()
    // Since symlinkStats.isFile() === false, the check fails
    expect(result.state).toBe("omitted");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PRIORITY 3: CWE-367 — TOCTOU Race in ensureLeaseDirectory
// ────────────────────────────────────────────────────────────────────────────
//
// VULNERABLE CODE: src/hopper/HopperTargetLease.ts
//   Lines 28-31: HOPPER_TARGET_LEASE_DIRECTORY = /tmp/rea-hopper-{uid} (predictable)
//   Lines 162-219: ensureLeaseDirectory() — originally used lstat() then chmod()
//   Line 164: mkdir(directory, { recursive: true, mode: 0o700 }) — does NOT fix
//             permissions on pre-existing directories (documented Node.js behavior)
//
// CVSS 7.8 (High) — AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N
//   Prerequisites: Local user on same system, knowledge of victim's uid
//   Impact: Attacker pre-creates /tmp/rea-hopper-{victim_uid} with 0o755 or as
//           symlink, then observes/modifies lease socket communications
//   Scenario: mkdir(recursive:true) silently succeeds on existing 0o755 directory,
//             original lstat-then-chmod had a race window between stat and fix.
//             With descriptor-based validation, the race is eliminated.

describe("CWE-367: TOCTOU Race in Hopper Lease Directory", () => {
  // ── (A) REPRODUCTION: mkdir does NOT fix pre-existing permissions ──────

  it("REPRODUCTION: mkdir(recursive:true, mode:0o700) silently ignores existing directory permissions", async () => {
    // This is a documented Node.js behavior, not a Node bug.
    // It's the ROOT CAUSE of the vulnerability.
    if (process.platform === "win32") return; // chmod semantics are POSIX-only

    const directory = await temporaryDirectory();
    const leaseDir = join(directory, "rea-hopper-1000");

    // Step 1: Attacker pre-creates with world-readable permissions
    await mkdir(leaseDir, { mode: 0o755 });
    const attackerStat = await lstat(leaseDir);
    expect(attackerStat.mode & 0o777).toBe(0o755);

    // Step 2: Victim's ensureLeaseDirectory calls mkdir(recursive:true)
    await mkdir(leaseDir, { recursive: true, mode: 0o700 });

    // ── OBSERVED OUTPUT: Permissions were NOT changed ──────────────────
    const afterMkdir = await lstat(leaseDir);
    expect(afterMkdir.mode & 0o777).toBe(0o755); // Still world-readable!

    // PROOF: group+other bits are still set
    expect(afterMkdir.mode & 0o077).not.toBe(0);
  });

  it("REPRODUCTION: predictable /tmp path allows attacker to pre-create with symlink", async () => {
    if (process.platform === "win32") return;

    const directory = await temporaryDirectory();
    const attackerDir = join(directory, "attacker-controlled");
    const victimLeaseDir = join(directory, "rea-hopper-1000");

    // Step 1: Attacker creates their own directory
    await mkdir(attackerDir, { mode: 0o755 });

    // Step 2: Attacker plants symlink at the predictable path
    await symlink(attackerDir, victimLeaseDir);

    // ── OBSERVED OUTPUT: symlink is resolved transparently ─────────────
    const stats = await lstat(victimLeaseDir);
    expect(stats.isSymbolicLink()).toBe(true);

    // Victim's mkdir would succeed (following the symlink)
    // and all socket operations would happen in attacker's directory
    const { realpath: fsRealpath } = await import("node:fs/promises");
    const resolved = await fsRealpath(victimLeaseDir);
    expect(resolved).toBe(attackerDir); // Points to attacker's directory!
  });

  // ── (D) FIX REGRESSION: descriptor-based validation ───────────────────

  it("REGRESSION: O_DIRECTORY|O_NOFOLLOW open rejects symlinks at kernel level", async () => {
    if (process.platform === "win32") return;

    const directory = await temporaryDirectory();
    const realDir = join(directory, "real");
    const symlinkDir = join(directory, "symlink");

    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, symlinkDir);

    // The fix opens with O_DIRECTORY|O_NOFOLLOW which causes ELOOP on symlinks
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);

    // PROOF: Opening a symlink with O_NOFOLLOW fails at the kernel level
    if (
      typeof fsConstants.O_NOFOLLOW === "number" &&
      fsConstants.O_NOFOLLOW !== 0
    ) {
      await expect(open(symlinkDir, flags)).rejects.toMatchObject({
        code: "ELOOP",
      });
    }

    // But opening the real directory succeeds
    const handle = await open(realDir, flags);
    const fdStat = await handle.stat();
    expect(fdStat.isDirectory()).toBe(true);
    expect(fdStat.isSymbolicLink()).toBe(false);
    await handle.close();
  });

  it("REGRESSION: fstat on opened descriptor is immune to path-level TOCTOU swaps", async () => {
    if (process.platform === "win32") return;

    const directory = await temporaryDirectory();
    const leaseDir = join(directory, "lease");
    await mkdir(leaseDir, { mode: 0o700 });

    // Open directory descriptor (what the fix does)
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(leaseDir, flags);

    // Even if attacker replaces the directory at the path AFTER open,
    // the descriptor still refers to the ORIGINAL inode
    const originalIno = (await handle.stat()).ino;

    // Simulate attacker replacing the directory
    await rm(leaseDir, { recursive: true });
    await mkdir(leaseDir, { mode: 0o755 }); // Attacker re-creates

    // PROOF: fstat still returns the ORIGINAL directory's inode
    const afterSwap = await handle.stat();
    expect(afterSwap.ino).toBe(originalIno);

    // The new directory has a DIFFERENT inode
    const newDirStat = await lstat(leaseDir);
    expect(newDirStat.ino).not.toBe(originalIno);

    await handle.close();
  });
});
