import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisExecution } from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationInput } from "../../domain/javascript/javascriptDeobfuscation.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import {
  JS_REDOX_LIMITS,
  JS_REDOX_PROVIDER_IDENTITY,
  JS_REDOX_RELEASE,
} from "./JsRedoxRelease.js";
import {
  parseJsRedoxReport,
  parseJsRedoxVersion,
  validateJsRedoxReport,
} from "./JsRedoxProtocol.js";
import {
  publishJsRedox,
  type JsRedoxEngineIdentity,
} from "./JsRedoxPublication.js";

const OPERATION = "deobfuscate_javascript_source";

export interface JsRedoxEngine extends JsRedoxEngineIdentity {
  readonly limiter: string;
}

interface StableSource {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export const executeJsRedox = async (input: {
  readonly request: JavaScriptDeobfuscationInput;
  readonly signal?: AbortSignal;
  readonly engine: JsRedoxEngine;
  readonly source: StableSource;
  readonly runtimePath: string;
  readonly tree: SafeOutputTree;
  readonly run: (
    arguments_: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<ProviderProcessSnapshot>;
}): Promise<AnalysisExecution> => {
  const snapshotPath = join(input.runtimePath, "source.js");
  const outputPath = join(input.runtimePath, "deobfuscated.js");
  const reportPath = join(input.runtimePath, "report.json");
  await writeFile(snapshotPath, input.source.bytes, {
    flag: "wx",
    mode: 0o600,
  });

  const versionRun = await input.run(
    ["--version"],
    input.runtimePath,
    input.signal,
  );
  const version = parseJsRedoxVersion(versionRun.stdout.text);
  if (version !== JS_REDOX_RELEASE.version)
    throw new AnalysisCapabilityUnavailableError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      OPERATION,
      `Unsupported js-redox version ${version ?? (versionRun.stdout.text.trim() || "missing")}; verified version is ${JS_REDOX_RELEASE.version}.`,
      {
        userMessage: `Provide js-redox deobfuscate-safe ${JS_REDOX_RELEASE.version}.`,
      },
    );

  const executionRun = await input.run(
    [
      snapshotPath,
      outputPath,
      "--report",
      reportPath,
      "--max-iterations",
      String(input.request.max_iterations),
    ],
    input.runtimePath,
    input.signal,
  );
  const output = await readStableArtifact(
    outputPath,
    JS_REDOX_LIMITS.outputBytes,
    input.signal,
  );
  const reportFile = await readStableArtifact(
    reportPath,
    JS_REDOX_LIMITS.reportBytes,
    input.signal,
  );
  const report = parseJsRedoxReport(reportFile.bytes);
  validateJsRedoxReport(report, {
    inputSha256: input.source.sha256,
    outputSha256: output.sha256,
    changed: output.sha256 !== input.source.sha256,
    maxIterations: input.request.max_iterations,
  });
  await assertInputsUnchanged(
    input.request.path,
    input.source.sha256,
    input.engine,
    input.signal,
  );
  return publishJsRedox({
    sourcePath: input.request.path,
    maxIterations: input.request.max_iterations,
    tree: input.tree,
    source: input.source,
    output,
    reportFile,
    report,
    engine: input.engine,
    version,
    versionRun,
    executionRun,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
};

const assertInputsUnchanged = async (
  sourcePath: string,
  sourceSha256: string,
  engine: JsRedoxEngine,
  signal?: AbortSignal,
): Promise<void> => {
  const currentSource = await readStableArtifact(
    sourcePath,
    JS_REDOX_LIMITS.inputBytes,
    signal,
  );
  const currentEngine = await readStableArtifact(
    engine.command,
    JS_REDOX_LIMITS.executableBytes,
    signal,
  );
  if (currentSource.sha256 !== sourceSha256)
    throw new AnalysisOutputError(
      OPERATION,
      `Original input changed during deobfuscation: ${sourcePath}`,
    );
  if (currentEngine.sha256 !== engine.sha256)
    throw new AnalysisOutputError(
      OPERATION,
      "Configured js-redox executable changed during deobfuscation.",
    );
};
