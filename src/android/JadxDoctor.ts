import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { inspectJadxAvailability } from "./JadxConfiguration.js";
import {
  JADX_JAR_CONFIGURATION_REMEDIATION,
  JADX_JAVA_RUNTIME_REMEDIATION,
  JADX_JVM_OPTIONS_REMEDIATION,
  JADX_UNSUPPORTED_HOST_REMEDIATION,
} from "./JadxRelease.js";

/** Project the validated JADX configuration into the doctor contract. */
export const inspectJadxProvider = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DoctorProviderInspection> => {
  const configured = environment.REA_JADX_MCP_JAR !== undefined;
  const availability = await inspectJadxAvailability(environment);
  // diagnostics is a loosely-typed JsonValue map; guard the published path
  // even though the success path always sets jar_path today.
  const jarPath =
    availability.status === "available" &&
    typeof availability.diagnostics["jar_path"] === "string"
      ? availability.diagnostics["jar_path"]
      : undefined;
  const available =
    availability.status === "available" && jarPath !== undefined;
  // Preserve the caller-selected JAR path (it may be a stable symlink) and
  // the validated JAVA_HOME selection; the resolved jarPath stays in
  // diagnostics as inspection evidence.
  const configuredJar = environment.REA_JADX_MCP_JAR;
  return {
    id: "jadx",
    configured,
    available,
    providerVersion: null,
    registrationEnvironment:
      jarPath === undefined || configuredJar === undefined
        ? {}
        : {
            REA_JADX_MCP_JAR: configuredJar,
            ...optionalEntry("JAVA_HOME", environment.JAVA_HOME),
            ...optionalEntry(
              "REA_JADX_HEAP_MIB",
              environment.REA_JADX_HEAP_MIB,
            ),
            ...optionalEntry(
              "REA_JADX_ACTIVE_PROCESSOR_COUNT",
              environment.REA_JADX_ACTIVE_PROCESSOR_COUNT,
            ),
          },
    checks: [configurationCheck(configured, availability, jarPath)],
  };
};

/**
 * Publish a caller-selected variable only when explicitly set; never persist
 * ambient inheritance. Values are validated before this point.
 */
const optionalEntry = (
  name: string,
  value: string | undefined,
): Record<string, string> => (value === undefined ? {} : { [name]: value });

const configurationCheck = (
  configured: boolean,
  availability: ProviderAvailability,
  jarPath: string | undefined,
): DoctorProviderCheck => {
  const code = availability.status === "unavailable" ? availability.code : null;
  if (availability.status === "available" && jarPath !== undefined) {
    return {
      name: "configuration",
      ok: true,
      code: null,
      detail: `JADX MCP bridge JAR validated at ${jarPath}; its path is recorded for agent registrations.`,
      remediation: null,
      classification: "config_drift",
    };
  }
  return {
    name: "configuration",
    ok: false,
    code,
    detail:
      availability.status === "available"
        ? "Validated JADX configuration reported no JAR path."
        : availability.reason,
    // Point at the failed requirement, selected from the failing phase: the
    // failure codes cover multiple phases (JVM options vs Java selection,
    // JAR inspection vs module inspection), and the diagnostics name the
    // failed setting or phase. Every failed check keeps a remediation.
    remediation: selectRemediation(
      code,
      availability.status === "unavailable" ? availability.diagnostics : {},
    ),
    classification:
      code === "unsupported_host"
        ? "unsupported_host"
        : code === "runtime_missing"
          ? "missing_dependency"
          : configured
            ? "config_drift"
            : "missing_analysis_engine",
  };
};

/**
 * Select remediation from the failing phase, not just the failure code:
 * `open_options_invalid` covers both malformed JVM resource overrides and a
 * non-absolute JAVA_HOME, and `unsupported_version` covers both a stale JDK
 * and a JAR missing bridge classes.
 */
const selectRemediation = (
  code: string | null,
  diagnostics: Readonly<Record<string, JsonValue>>,
): string | null => {
  if (code === "unsupported_host") return JADX_UNSUPPORTED_HOST_REMEDIATION;
  if (code === "runtime_missing") return JADX_JAVA_RUNTIME_REMEDIATION;
  if (code === "open_options_invalid")
    return typeof diagnostics["setting"] === "string"
      ? JADX_JVM_OPTIONS_REMEDIATION
      : JADX_JAVA_RUNTIME_REMEDIATION;
  if (code === "unsupported_version")
    return diagnostics["phase"] === "jar-inspection"
      ? JADX_JAR_CONFIGURATION_REMEDIATION
      : JADX_JAVA_RUNTIME_REMEDIATION;
  return JADX_JAR_CONFIGURATION_REMEDIATION;
};
