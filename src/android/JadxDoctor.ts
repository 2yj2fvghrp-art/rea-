import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { inspectJadxAvailability } from "./JadxConfiguration.js";
import {
  JADX_JAR_CONFIGURATION_REMEDIATION,
  JADX_JAVA_RUNTIME_REMEDIATION,
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
            ...(environment.JAVA_HOME === undefined
              ? {}
              : { JAVA_HOME: environment.JAVA_HOME }),
          },
    checks: [configurationCheck(configured, availability, jarPath)],
  };
};

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
    // Point at the failed requirement: Java selection failures need JDK
    // guidance, and an unsupported host is already explained by the reason.
    remediation:
      code === "runtime_missing" || code === "open_options_invalid"
        ? JADX_JAVA_RUNTIME_REMEDIATION
        : code === "unsupported_host"
          ? null
          : JADX_JAR_CONFIGURATION_REMEDIATION,
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
