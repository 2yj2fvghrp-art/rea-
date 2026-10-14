import { accessSync, constants, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseEnvironment } from "./environment.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";
import { parseStringArray, parseLoaderArgs } from "./parsers.js";
import type { AppConfig } from "./types.js";
import {
  REA_MANAGED_LINUX_HOPPER_LAUNCHER,
  linuxHopperLauncherCandidates,
  linuxSharedLibrariesAvailable,
} from "../application/LinuxHopper.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";

/**
 * Hard deadline for the synchronous linker probe. `parseConfig` runs at the
 * synchronous composition root — MCP startup and every direct-analysis
 * command — so the `ldd` child selected from the caller's PATH must never
 * block it indefinitely: when the deadline expires Node kills the child and
 * `execFileSync` throws, which fails the candidate closed like any other
 * probe error. The repository's async process supervision
 * (`src/process/ExecFileOutput`) cannot serve a synchronous composition
 * root, so the bound lives on the child itself: `timeout` kills on expiry
 * and `SIGKILL` (rather than the default `SIGTERM`) guarantees termination
 * even if the PATH-selected wrapper traps signals. Exported for tests.
 */
export const LDD_PROBE_TIMEOUT_MS = 10_000;

/**
 * Mirror doctor discovery's launcher readiness decision so runtime
 * configuration and `rea doctor` select the same launcher: execute access
 * alone is not readiness. The path must be a regular file, and on Linux its
 * shared libraries must resolve under `ldd`. Fail closed: any probe error
 * means the candidate is not selected. The linker probe runs under the
 * caller-selected environment — the same environment execution launches
 * Hopper with — so discovery and execution agree. The probe is
 * deadline-bounded so a stalled `ldd` cannot hang the composition root.
 * Exported for tests.
 */
export const executableAvailable = (
  path: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  probeTimeoutMs: number = LDD_PROBE_TIMEOUT_MS,
): boolean => {
  try {
    accessSync(path, constants.X_OK);
    // A directory can pass X_OK; the launcher must be a regular file.
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "linux") return true;
    const linked = execFileSync("ldd", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: environment,
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
    });
    return linuxSharedLibrariesAvailable(linked);
  } catch {
    return false;
  }
};

/** Default Hopper launcher, shared with doctor discovery's candidate order. Exported for tests. */
export const defaultHopperLauncherPath = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  executable: (path: string) => boolean = (candidate) =>
    executableAvailable(candidate, environment),
): string => {
  if (platform !== "linux") return DEFAULT_HOPPER_LAUNCHER_PATH;
  // Search the same ordered candidates as doctor discovery so both select
  // the same launcher.
  return (
    linuxHopperLauncherCandidates(homeDirectory).find((candidate) =>
      executable(candidate),
    ) ?? REA_MANAGED_LINUX_HOPPER_LAUNCHER
  );
};

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsed = parseEnvironment(environment);
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  const loaderArgs = parseLoaderArgs(env.HOPPER_LOADER_ARGS_JSON);
  if (!loaderArgs.ok) return loaderArgs;
  const secretPatterns = parseStringArray(
    env.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  // Ghidra's analyzeHeadless accepts -cspec only together with -processor.
  if (
    env.REA_GHIDRA_COMPILER_SPEC_ID !== undefined &&
    env.REA_GHIDRA_LANGUAGE_ID === undefined
  )
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        settings: [
          {
            setting: "REA_GHIDRA_COMPILER_SPEC_ID",
            constraint: "requires REA_GHIDRA_LANGUAGE_ID",
          },
        ],
      }),
    );
  return ok({
    ...(env.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? {}
      : { mcpMaxResponseBytes: env.REA_MCP_MAX_RESPONSE_BYTES }),
    ...(env.REA_MCP_INPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpInputSchemaProfile: env.REA_MCP_INPUT_SCHEMA_PROFILE }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_IDA_MCP_CONFIG === undefined
      ? {}
      : { idaMcpConfigPath: env.REA_IDA_MCP_CONFIG }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: env.JAVA_HOME,
    ghidraStartupTimeoutMs: env.REA_GHIDRA_STARTUP_TIMEOUT_MS,
    ...(env.REA_GHIDRA_LANGUAGE_ID === undefined
      ? {}
      : {
          ghidraLanguageOverride: {
            languageId: env.REA_GHIDRA_LANGUAGE_ID,
            ...(env.REA_GHIDRA_COMPILER_SPEC_ID === undefined
              ? {}
              : { compilerSpecId: env.REA_GHIDRA_COMPILER_SPEC_ID }),
          },
        }),
    ...(env.REA_GHIDRA_SEED_FILE === undefined
      ? {}
      : { ghidraSeedFile: env.REA_GHIDRA_SEED_FILE }),
    ...(env.REA_GHIDRA_DISABLED_ANALYZERS === undefined
      ? {}
      : { ghidraDisabledAnalyzers: env.REA_GHIDRA_DISABLED_ANALYZERS }),
    ...(env.REA_GHIDRA_NATIVEAOT_JAR === undefined
      ? {}
      : { ghidraNativeAotJar: env.REA_GHIDRA_NATIVEAOT_JAR }),
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    hopperLauncherPath:
      env.HOPPER_LAUNCHER_PATH ??
      defaultHopperLauncherPath(
        process.platform,
        homeDirectoryFromEnvironment(environment, process.platform),
        environment,
      ),
    hopperStartupTimeoutMs: env.REA_HOPPER_STARTUP_TIMEOUT_MS,
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: loaderArgs.value,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: { secretPatterns: secretPatterns.value },
  });
};
