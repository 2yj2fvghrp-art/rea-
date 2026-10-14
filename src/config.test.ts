import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHopperLauncherPath,
  executableAvailable,
  parseConfig,
} from "./config/parseConfig.js";
import { linuxHopperLauncherCandidates } from "./application/LinuxHopper.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";

it("reports a configuration failure for a NUL in Hopper loader arguments", () => {
  const result = parseConfig({
    HOPPER_LOADER_ARGS_JSON: JSON.stringify(["--option", "value\0suffix"]),
  });
  if (result.ok)
    throw new Error("NUL argv cannot be passed to a child process");
  expect(result.error).toMatchObject({
    settings: [{ setting: "HOPPER_LOADER_ARGS_JSON" }],
  });
  expect(result.error.message).toContain("NUL");
});

describe("runtime configuration", () => {
  it("allows target-free startup and applies runtime defaults", () => {
    const empty = parseConfig({});
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.hopperTargetPath).toBeUndefined();
      expect(empty.value.analysisProvider).toBe("auto");
      expect(empty.value.hopperStartupTimeoutMs).toBe(120_000);
    }
    const result = parseConfig({ HOPPER_TARGET_PATH: "/usr/bin/true" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hopperTargetKind).toBe("executable");
      expect(result.value.hopperLoaderArgs).toEqual([]);
      expect(result.value.logLevel).toBe("info");
      expect(result.value.referenceSourcePolicy).toEqual({
        secretPatterns: [],
      });
    }
  });

  it("parses one shared provider selector and rejects unstable IDs", () => {
    expect(
      parseConfig({
        REA_ANALYSIS_PROVIDER: "ida",
        REA_IDA_MCP_CONFIG: "/tmp/ida-mcp.json",
      }),
    ).toMatchObject({
      ok: true,
      value: { analysisProvider: "ida", idaMcpConfigPath: "/tmp/ida-mcp.json" },
    });
    expect(parseConfig({ REA_IDA_MCP_CONFIG: "relative.json" }).ok).toBe(false);
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "ghidra" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "ghidra" },
    });
    expect(parseConfig({ REA_ANALYSIS_PROVIDER: "auto" })).toMatchObject({
      ok: true,
      value: { analysisProvider: "auto" },
    });
    for (const invalid of ["", "Auto", "ghidra_1", "ghidra "])
      expect(parseConfig({ REA_ANALYSIS_PROVIDER: invalid }).ok).toBe(false);
  });

  it("parses absolute BYO Ghidra and optional Java paths", () => {
    expect(
      parseConfig({
        GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
        JAVA_HOME: "/usr/lib/jvm/jdk-21",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        ghidraInstallDir: "/opt/ghidra_12.1.4_PUBLIC",
        ghidraJavaHome: "/usr/lib/jvm/jdk-21",
      },
    });
    expect(parseConfig({ GHIDRA_INSTALL_DIR: "relative/ghidra" }).ok).toBe(
      false,
    );
    expect(parseConfig({ JAVA_HOME: "relative/jdk" }).ok).toBe(false);
  });

  it("parses an optional absolute BYO ilspycmd path", () => {
    expect(
      parseConfig({ REA_ILSPY_CMD_PATH: "/home/user/.dotnet/tools/ilspycmd" }),
    ).toMatchObject({
      ok: true,
      value: {
        ilspyCmdPath: "/home/user/.dotnet/tools/ilspycmd",
      },
    });
    expect(parseConfig({ REA_ILSPY_CMD_PATH: "relative/ilspycmd" }).ok).toBe(
      false,
    );
  });
});

describe("runtime target configuration", () => {
  it("rejects invalid target kinds with actionable environment diagnostics", () => {
    const result = parseConfig({ HOPPER_TARGET_KIND: "archive" });
    if (result.ok) throw new Error("Expected invalid target kind");
    expect(result.error.message).toContain("Invalid REA environment");
  });

  it("parses database kind and loader arguments", () => {
    expect(
      parseConfig({
        HOPPER_LAUNCHER_PATH: "/custom/hopper",
        REA_ANALYSIS_PROVIDER: "hopper",
        HOPPER_TARGET_PATH: "/fixture/sample.hop",
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: '["-l","FAT","--aarch64","-l","Mach-O"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        hopperLauncherPath: "/custom/hopper",
        analysisProvider: "hopper",
        hopperTargetPath: "/fixture/sample.hop",
        hopperTargetKind: "database",
        hopperLoaderArgs: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
        logLevel: "info",
        referenceSourcePolicy: {
          secretPatterns: [],
        },
      },
    });
  });
});

describe("runtime collection configuration", () => {
  it("preserves empty loader arguments and rejects empty exclusion patterns", () => {
    expect(
      parseConfig({ HOPPER_LOADER_ARGS_JSON: '["", " ", "--option"]' }),
    ).toMatchObject({
      ok: true,
      value: { hopperLoaderArgs: ["", " ", "--option"] },
    });
    expect(parseConfig({ REA_REFERENCE_SECRET_PATTERNS_JSON: '[""]' }).ok).toBe(
      false,
    );
  });

  it.each(["not-json", "{}", '"just a string"', '["ok",1]'])(
    "rejects invalid loader args: %s",
    (encoded) => {
      const result = parseConfig({
        HOPPER_TARGET_PATH: "/tmp/a",
        HOPPER_LOADER_ARGS_JSON: encoded,
      });
      if (result.ok)
        throw new Error("expected malformed loader arguments to fail");
      expect(result.error.message).toContain(
        encoded === "not-json" ? "valid JSON" : "array of strings",
      );
    },
  );

  it("parses supported log levels and rejects unknown levels", () => {
    const configured = parseConfig({ REA_LOG_LEVEL: "debug" });
    expect(configured.ok && configured.value.logLevel).toBe("debug");
    expect(parseConfig({ REA_LOG_LEVEL: "verbose" }).ok).toBe(false);
  });

  it("parses reference source secret patterns", () => {
    const result = parseConfig({
      REA_REFERENCE_SECRET_PATTERNS_JSON: '["*.env", "*.pem", "secrets/"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referenceSourcePolicy).toEqual({
        secretPatterns: ["*.env", "*.pem", "secrets/"],
      });
    }
  });

  it.each(["not-json", "{}", '["*.ok", 1]'])(
    "rejects invalid reference source secret patterns: %s",
    (encoded) => {
      expect(
        parseConfig({ REA_REFERENCE_SECRET_PATTERNS_JSON: encoded }).ok,
      ).toBe(false);
    },
  );
});

describe("configuration failure diagnostics", () => {
  it.each(["1", "900000", "2147483647"])(
    "accepts Hopper startup deadline %s without changing Ghidra's deadline",
    (value) => {
      expect(
        parseConfig({ REA_HOPPER_STARTUP_TIMEOUT_MS: value }),
      ).toMatchObject({
        ok: true,
        value: {
          hopperStartupTimeoutMs: Number(value),
          ghidraStartupTimeoutMs: 330_000,
        },
      });
    },
  );

  it.each(["", "0", "-1", "1.5", "1e3", "invalid", "2147483648"])(
    "rejects malformed Hopper startup deadline %j with its setting",
    (value) => {
      const result = parseConfig({ REA_HOPPER_STARTUP_TIMEOUT_MS: value });
      if (result.ok) throw new Error("Expected invalid startup deadline");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "configuration_invalid",
        category: "invalid_input",
        details: {
          settings: [
            {
              setting: "REA_HOPPER_STARTUP_TIMEOUT_MS",
              constraint: expect.any(String),
            },
          ],
        },
      });
    },
  );

  it.each([
    "",
    " ",
    "0",
    "-5",
    "abc",
    "1.5",
    "1e3",
    "0x100",
    "2147483648",
    "9007199254740991",
  ])(
    "rejects malformed Ghidra startup deadline %j with its setting and constraint",
    (value) => {
      const result = parseConfig({ REA_GHIDRA_STARTUP_TIMEOUT_MS: value });
      if (result.ok) throw new Error("Expected invalid startup deadline");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "configuration_invalid",
        category: "invalid_input",
        details: {
          settings: [
            {
              setting: "REA_GHIDRA_STARTUP_TIMEOUT_MS",
              constraint: expect.any(String),
            },
          ],
        },
      });
    },
  );

  it.each(["1", "90000", "2147483647"])(
    "accepts Swift compile deadline %s without changing Hopper's deadline",
    (value) => {
      expect(
        parseConfig({ REA_SWIFTC_COMPILE_TIMEOUT_MS: value }),
      ).toMatchObject({
        ok: true,
        value: {
          hopperStartupTimeoutMs: 120_000,
        },
      });
    },
  );

  it.each(["", "0", "-1", "1.5", "1e3", "invalid", "2147483648"])(
    "rejects malformed Swift compile deadline %j with its setting",
    (value) => {
      const result = parseConfig({ REA_SWIFTC_COMPILE_TIMEOUT_MS: value });
      if (result.ok) throw new Error("Expected invalid Swift compile deadline");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "configuration_invalid",
        category: "invalid_input",
        details: {
          settings: [
            {
              setting: "REA_SWIFTC_COMPILE_TIMEOUT_MS",
              constraint: expect.any(String),
            },
          ],
        },
      });
    },
  );

  it.each([
    ["GHIDRA_INSTALL_DIR", "./fixture"],
    ["JAVA_HOME", "./jdk"],
    ["REA_GHIDRA_NATIVEAOT_JAR", "./missing.jar"],
  ])(
    "names the rejected %s and its absolute-path constraint",
    (setting, value) => {
      const result = parseConfig({ [setting]: value });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const constraint = `${setting} must be absolute`;
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "configuration_invalid",
        category: "invalid_input",
        message: `REA configuration is invalid: ${constraint}.`,
        remediation: { action: expect.stringContaining(`Correct ${setting} `) },
        details: { settings: [{ setting, constraint }] },
      });
      // The rejected value itself is not echoed.
      expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
        value,
      );
    },
  );

  it("names settings rejected by their own parsers", () => {
    const result = parseConfig({ HOPPER_LOADER_ARGS_JSON: "not-json" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: {
          settings: [
            {
              setting: "HOPPER_LOADER_ARGS_JSON",
              constraint: "HOPPER_LOADER_ARGS_JSON must be valid JSON",
            },
          ],
        },
      });
  });
});

describe("default Hopper launcher path (#2270)", () => {
  const home = "/fixture/home";
  const executable = (present: readonly string[]) => (path: string) =>
    present.includes(path);

  it("selects each newly discovered Linux launcher when it is the only one present", () => {
    for (const candidate of ["/opt/hopper-v4/bin/hopper", "/usr/bin/hopper"]) {
      expect(
        defaultHopperLauncherPath(
          "linux",
          home,
          process.env,
          executable([candidate]),
        ),
      ).toBe(candidate);
    }
  });

  it("prefers the REA-managed install over the newly discovered launchers", () => {
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        process.env,
        executable([
          "/opt/hopper/bin/Hopper",
          "/opt/hopper-v4/bin/hopper",
          "/usr/bin/hopper",
        ]),
      ),
    ).toBe("/opt/hopper/bin/Hopper");
  });

  it("prefers the legacy user-local launcher over the newly discovered system launchers", () => {
    const userLocal = `${home}/.local/share/rea/hopper/bin/Hopper`;
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        process.env,
        executable(["/opt/hopper-v4/bin/hopper", "/usr/bin/hopper", userLocal]),
      ),
    ).toBe(userLocal);
  });

  it("prefers the REA-managed install over the legacy user-local launcher", () => {
    const userLocal = `${home}/.local/share/rea/hopper/bin/Hopper`;
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        process.env,
        executable(["/opt/hopper/bin/Hopper", userLocal]),
      ),
    ).toBe("/opt/hopper/bin/Hopper");
  });

  it("orders the shared Linux candidates: managed, user-local, then system-wide", () => {
    expect(linuxHopperLauncherCandidates(home)).toEqual([
      "/opt/hopper/bin/Hopper",
      `${home}/.local/share/rea/hopper/bin/Hopper`,
      "/opt/hopper-v4/bin/hopper",
      "/usr/bin/hopper",
    ]);
  });

  it("falls back to the user-local launcher, then the REA-managed path", () => {
    const userLocal = `${home}/.local/share/rea/hopper/bin/Hopper`;
    expect(
      defaultHopperLauncherPath(
        "linux",
        home,
        process.env,
        executable([userLocal]),
      ),
    ).toBe(userLocal);
    expect(
      defaultHopperLauncherPath("linux", home, process.env, executable([])),
    ).toBe("/opt/hopper/bin/Hopper");
  });
});

describe.runIf(process.platform === "linux")(
  "Hopper launcher readiness probe (#2995)",
  () => {
    // Fixtures for the default readiness probe: execute access alone is not
    // readiness. A directory passes X_OK but is not a launcher, and a script
    // fails the ldd leg that doctor discovery also requires.
    // Fixture creation lives in beforeAll: Vitest invokes the describe
    // factory during collection even when the suite is skipped, so the
    // unconditional /bin/true copy would throw on platforms without it
    // before the suite could be skipped.
    let fixtureRoot = "";
    let asDirectory = "";
    let brokenScript = "";
    let healthyBinary = "";
    beforeAll(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "rea-hopper-probe-"));
      asDirectory = join(fixtureRoot, "hopper-dir");
      mkdirSync(asDirectory, { recursive: true });
      chmodSync(asDirectory, 0o755);

      brokenScript = join(fixtureRoot, "broken.sh");
      writeFileSync(brokenScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      healthyBinary = join(fixtureRoot, "hopper-ok");
      copyFileSync("/bin/true", healthyBinary);
      chmodSync(healthyBinary, 0o755);
    });
    afterAll(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it("rejects directories and launchers with unresolvable libraries", () => {
      expect(executableAvailable(asDirectory)).toBe(false);
      expect(executableAvailable(brokenScript)).toBe(false);
    });

    it("accepts a healthy executable binary", () => {
      expect(executableAvailable(healthyBinary)).toBe(true);
    });

    it("rejects missing paths", () => {
      expect(executableAvailable(join(fixtureRoot, "missing"))).toBe(false);
    });

    it("runs the linker probe under the caller-selected environment", () => {
      const probeRoot = mkdtempSync(join(tmpdir(), "rea-hopper-env-"));
      try {
        // A fake ldd first on the caller-selected PATH dumps the environment
        // it actually receives, then reports resolvable libraries.
        const childEnvDump = join(probeRoot, "child-env.txt");
        const fakeLdd = join(probeRoot, "ldd");
        writeFileSync(
          fakeLdd,
          `#!/bin/sh\nenv | sort > ${childEnvDump}\nprintf '\\tlibc.so.6 => /lib/libc.so.6 (0x0000)\\n'\n`,
          { mode: 0o755 },
        );
        const callerEnvironment = {
          PATH: `${probeRoot}:${process.env.PATH ?? ""}`,
          REA_PROBE_MARKER: "caller-selected-environment",
        };
        expect(executableAvailable(healthyBinary, callerEnvironment)).toBe(
          true,
        );
        expect(readFileSync(childEnvDump, "utf8")).toContain(
          "REA_PROBE_MARKER=caller-selected-environment",
        );
      } finally {
        rmSync(probeRoot, { recursive: true, force: true });
      }
    });

    it(
      "fails a stalled linker probe closed within its deadline",
      { timeout: 30_000 },
      () => {
        const probeRoot = mkdtempSync(join(tmpdir(), "rea-hopper-stall-"));
        try {
          // A PATH-selected ldd that never answers: without a probe deadline
          // this would block parseConfig — and MCP startup — indefinitely.
          const fakeLdd = join(probeRoot, "ldd");
          writeFileSync(fakeLdd, "#!/bin/sh\nexec sleep 30\n", {
            mode: 0o755,
          });
          const callerEnvironment = {
            PATH: `${probeRoot}:${process.env.PATH ?? ""}`,
          };
          const deadlineMs = 1_000;
          const started = Date.now();
          expect(
            executableAvailable(healthyBinary, callerEnvironment, deadlineMs),
          ).toBe(false);
          // Bounded by the deadline, not by the 30s sleep: without the fix
          // this test hangs until its own timeout instead of returning.
          expect(Date.now() - started).toBeLessThan(15_000);
        } finally {
          rmSync(probeRoot, { recursive: true, force: true });
        }
      },
    );
  },
);
