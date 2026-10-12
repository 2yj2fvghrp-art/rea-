import { dirname } from "node:path";
import { realpath } from "node:fs/promises";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "./ElectronActiveObservationPort.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { ElectronActiveObservationInput } from "../../domain/javascript/electronActiveObservation.js";
import { err, type Result } from "../../domain/result.js";
import { createElectronActiveEvidence } from "./ElectronActiveEvidence.js";

const OPERATION = "capture_electron_scenario" as const;
const PROVIDER_ID = "rea-playwright-electron-active";
type CanonicalElectronActiveObservationInput =
  ElectronActiveObservationInput & {
    readonly application_root: string;
  };

const canonicalizeInput = async (
  input: ElectronActiveObservationInput,
): Promise<Result<CanonicalElectronActiveObservationInput, AnalysisError>> => {
  const resolvePath = async (
    field: "executable_path" | "application_path" | "application_root",
    path: string,
  ): Promise<string> => {
    try {
      return await realpath(path);
    } catch (cause: unknown) {
      throw new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [field],
          reason: "invalid_value",
          message: `The ${field} does not resolve to an existing path: ${path}`,
        },
      ]);
    }
  };
  try {
    const [executablePath, applicationPath] = await Promise.all([
      resolvePath("executable_path", input.executable_path),
      resolvePath("application_path", input.application_path),
    ]);
    const applicationRoot =
      input.application_root === undefined
        ? dirname(applicationPath)
        : await resolvePath("application_root", input.application_root);
    return {
      ok: true,
      value: {
        ...input,
        executable_path: executablePath,
        application_path: applicationPath,
        application_root: applicationRoot,
      },
    };
  } catch (cause: unknown) {
    if (cause instanceof AnalysisInputError) return err(cause);
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["application_path"],
          reason: "invalid_format",
          message:
            "Electron executable, application, and root must resolve to existing paths",
        },
      ]),
    );
  }
};

/** Canonicalize request paths and execute one provider-owned Electron run. */
export const captureElectronScenario = async (
  provider: ElectronActiveObservationPort | undefined,
  input: ElectronActiveObservationInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const canonical = await canonicalizeInput(input);
  if (!canonical.ok) return canonical;
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "active Electron observation provider is not configured",
      ),
    );
  const captured = await provider.capture(canonical.value, options);
  return captured.ok
    ? {
        ok: true,
        value: createElectronActiveEvidence(
          canonical.value,
          captured.value,
          provider.identity(),
        ),
      }
    : captured;
};
