import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  inspectJadxAvailability,
  JADX_FAILURE_KINDS,
  projectJadxFailureOutcome,
  type JadxFailureKind,
} from "./JadxConfiguration.js";

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
  // The failure kind is tagged at the configuration boundary; project its
  // remediation and classification here instead of reinterpreting the
  // phase/setting evidence. Every failed check keeps a remediation.
  const outcome = projectJadxFailureOutcome(
    availability.status === "unavailable"
      ? asFailureKind(availability.diagnostics["failure_kind"])
      : null,
    configured,
  );
  return {
    name: "configuration",
    ok: false,
    code,
    detail:
      availability.status === "available"
        ? "Validated JADX configuration reported no JAR path."
        : availability.reason,
    remediation: outcome.remediation,
    classification: outcome.classification,
  };
};

/** Validate the loose diagnostics tag against the boundary's failure kinds. */
const asFailureKind = (value: JsonValue | undefined): JadxFailureKind | null =>
  typeof value === "string" &&
  (JADX_FAILURE_KINDS as readonly string[]).includes(value)
    ? (value as JadxFailureKind)
    : null;
