import { isAbsolute } from "node:path";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Environment keys selecting the caller's tshark and capinfos binaries. */
export const TSHARK_COMMAND_ENV = "REA_TSHARK_COMMAND";
export const CAPINFOS_COMMAND_ENV = "REA_CAPINFOS_COMMAND";

const VERSION_TIMEOUT_MS = 20_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** How each tool was selected for this provider instance. */
export interface PcapToolSelection {
  readonly tshark: { command: string; source: "environment" | "path" };
  readonly capinfos: { command: string; source: "environment" | "path" };
}

/**
 * Resolve the caller-supplied tshark and capinfos binaries. Each accepts an
 * absolute environment path or falls back to PATH resolution, mirroring the
 * mitmdump pattern. REA never installs the Wireshark suite.
 */
export const resolvePcapTools = (
  environment: Readonly<Record<string, string | undefined>>,
): PcapToolSelection => {
  const tsharkEnv = environment[TSHARK_COMMAND_ENV];
  const capinfosEnv = environment[CAPINFOS_COMMAND_ENV];
  if (
    tsharkEnv !== undefined &&
    tsharkEnv.trim() !== "" &&
    !isAbsolute(tsharkEnv)
  )
    throw new PcapConfigurationFailure(
      "tshark_not_absolute",
      `${TSHARK_COMMAND_ENV} must be an absolute path to the tshark binary`,
      { configured: tsharkEnv },
    );
  if (
    capinfosEnv !== undefined &&
    capinfosEnv.trim() !== "" &&
    !isAbsolute(capinfosEnv)
  )
    throw new PcapConfigurationFailure(
      "capinfos_not_absolute",
      `${CAPINFOS_COMMAND_ENV} must be an absolute path to the capinfos binary`,
      { configured: capinfosEnv },
    );
  return {
    tshark: {
      command:
        tsharkEnv === undefined || tsharkEnv.trim() === ""
          ? "tshark"
          : tsharkEnv,
      source:
        tsharkEnv === undefined || tsharkEnv.trim() === ""
          ? "path"
          : "environment",
    },
    capinfos: {
      command:
        capinfosEnv === undefined || capinfosEnv.trim() === ""
          ? "capinfos"
          : capinfosEnv,
      source:
        capinfosEnv === undefined || capinfosEnv.trim() === ""
          ? "path"
          : "environment",
    },
  };
};

export type PcapConfigurationFailureCode =
  | "tshark_not_absolute"
  | "capinfos_not_absolute"
  | "tshark_missing"
  | "capinfos_missing"
  | "tshark_version_unresolved"
  | "capinfos_version_unresolved";

export class PcapConfigurationFailure extends Error {
  constructor(
    readonly code: PcapConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Read the version from the first line of `--version` output. */
const parseVersion = (stdout: string): string | null => {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line === undefined ? null : line;
};

/** Probe one tool; returns its version line or null if unusable. */
const probeTool = async (
  command: string,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileOutput(command, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseVersion(stdout);
  } catch {
    return null;
  }
};

export interface PcapClientIdentity {
  readonly tsharkVersion: string | null;
  readonly capinfosVersion: string | null;
}

/** Probe both tools without reading any capture file. */
export const inspectPcapClient = async (
  selection: PcapToolSelection,
  signal?: AbortSignal,
): Promise<PcapClientIdentity> => ({
  tsharkVersion: await probeTool(selection.tshark.command, signal),
  capinfosVersion: await probeTool(selection.capinfos.command, signal),
});

/** Availability in the shape shared by every provider. */
const rejectionCodeOf = (
  code: PcapConfigurationFailureCode,
): ProviderRejectionCode =>
  code.includes("missing")
    ? "executable_missing"
    : code.includes("not_absolute")
      ? "not_configured"
      : "version_unresolved";

export const pcapConfigurationAvailability = (
  cause: PcapConfigurationFailure,
): ProviderAvailability =>
  ({
    status: "unavailable",
    code: rejectionCodeOf(cause.code),
    reason: cause.message,
    diagnostics: { ...cause.diagnostics },
  }) as ProviderAvailability;
