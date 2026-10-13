import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { inspectJadxAvailability } from "./JadxConfiguration.js";
import { JADX_JAR_CONFIGURATION_REMEDIATION } from "./JadxRelease.js";

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
  return {
    id: "jadx",
    configured,
    available,
    providerVersion: null,
    registrationEnvironment:
      jarPath === undefined ? {} : { REA_JADX_MCP_JAR: jarPath },
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
    remediation: JADX_JAR_CONFIGURATION_REMEDIATION,
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
