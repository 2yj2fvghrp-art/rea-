export const scopeFields = [
  "kind",
  "identifier",
  "versions",
  "policy_reference",
];
export const findingFields = [
  "id",
  "title",
  "entry_point",
  "observation",
  "evidence_refs",
  "inference",
  "unknowns",
  "reproduction",
  "impact",
];
export const value = (input) => (typeof input === "string" ? input : "");

export const textFields = [
  "programName",
  "programUrl",
  "programPlatform",
  "participation",
  "participationCheckedAt",
  "policyUrl",
  "policyCapturedAt",
  "policyVersion",
  "policyCopyPath",
  "policyText",
  "exclusions",
  "allowedTechniques",
  "prohibitedTechniques",
  "limits",
  "accountRules",
  "privacyRules",
  "reportChannel",
  "disclosureRules",
  "policyUnknowns",
  "artifactType",
  "artifactIdentifier",
  "artifactVersion",
  "artifactSource",
  "artifactAcquiredAt",
  "artifactPath",
  "artifactSha256",
  "testEnvironment",
  "providerVersions",
  "analysisLog",
];

/** Accept only the bounded, documented case shape from an imported JSON file. */
export const normalizeCase = (input) => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    input.schema_version !== 1
  )
    throw new Error("This is not a version 1 REA research case.");
  const fields = {};
  for (const name of textFields) fields[name] = value(input.fields?.[name]);
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  if (scopes.length > 100 || findings.length > 100)
    throw new Error(
      "Case JSON exceeds 100 scope or finding rows; split the case before importing.",
    );
  return {
    schema_version: 1,
    created_at: value(input.created_at),
    updated_at: value(input.updated_at),
    fields,
    scopes: scopes.map((row) =>
      Object.fromEntries(scopeFields.map((key) => [key, value(row?.[key])])),
    ),
    findings: findings.map((row) =>
      Object.fromEntries(findingFields.map((key) => [key, value(row?.[key])])),
    ),
    policy_sha256: value(input.policy_sha256),
  };
};

const hasHttpUrl = (candidate) => {
  try {
    return ["http:", "https:"].includes(new URL(candidate).protocol);
  } catch {
    return false;
  }
};
const hasZonedTime = (candidate) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    candidate,
  ) && Number.isFinite(Date.parse(candidate));
const isAbsoluteFilePath = (candidate) =>
  candidate.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(candidate) ||
  /^\\\\[^\\]+\\[^\\]+/.test(candidate);

const missingProgramFacts = (fields) => {
  const missing = [];
  if (!hasHttpUrl(fields.programUrl)) missing.push("A valid program URL");
  if (!fields.participation.trim())
    missing.push("Current participation status");
  if (!hasZonedTime(fields.participationCheckedAt.trim()))
    missing.push("Participation check time with time zone");
  if (!hasHttpUrl(fields.policyUrl))
    missing.push("The exact policy source URL");
  if (!hasZonedTime(fields.policyCapturedAt.trim()))
    missing.push("Policy capture time with time zone");
  if (!fields.policyText.trim())
    missing.push("Applicable policy and scope text");
  if (!isAbsoluteFilePath(fields.policyCopyPath.trim()))
    missing.push("Absolute saved policy snapshot path");
  if (!fields.reportChannel.trim()) missing.push("Program report channel");
  if (!fields.disclosureRules.trim())
    missing.push("Disclosure rules, or an explicit unknown");
  return missing;
};

const missingScopeFacts = (researchCase) => {
  const fields = researchCase.fields;
  const missing = [];
  if (
    !researchCase.scopes.some(
      (row) =>
        row.kind.trim() && row.identifier.trim() && row.policy_reference.trim(),
    )
  )
    missing.push(
      "An exact in-scope asset kind, identifier, and policy reference",
    );
  if (!fields.exclusions.trim())
    missing.push("Explicit exclusions, or 'none stated' / 'unknown'");
  if (!fields.allowedTechniques.trim() || !fields.prohibitedTechniques.trim())
    missing.push("Allowed and prohibited techniques, or explicit unknowns");
  if (!fields.limits.trim() || !fields.accountRules.trim())
    missing.push("Rate limits and test-account rules, or explicit unknowns");
  if (!fields.privacyRules.trim())
    missing.push("Privacy and retention rules, or an explicit unknown");
  return missing;
};

const missingArtifactFacts = (fields) => {
  const missing = [];
  if (!fields.artifactType || !isAbsoluteFilePath(fields.artifactPath.trim()))
    missing.push("Artifact type and absolute local path");
  if (!fields.artifactIdentifier.trim())
    missing.push("Exact artifact package, bundle, or product identifier");
  if (!fields.artifactSource.trim())
    missing.push("Artifact acquisition source");
  if (!/^[a-f\d]{64}$/i.test(fields.artifactSha256.trim()))
    missing.push("Artifact SHA-256");
  if (!fields.artifactVersion.trim())
    missing.push("Artifact version and build");
  return missing;
};

/** List missing intake facts without treating completion as authorization. */
export const missingCaseFacts = (researchCase) => [
  ...missingProgramFacts(researchCase.fields),
  ...missingScopeFacts(researchCase),
  ...missingArtifactFacts(researchCase.fields),
];

const quoteShell = (input) => `'${input.replaceAll("'", "'\\''")}'`;
const quotePowerShell = (input) => `'${input.replaceAll("'", "''")}'`;

/** Show a starting REA command without invoking a provider or target. */
export const startingCommand = (researchCase) => {
  const { artifactType, artifactPath } = researchCase.fields;
  if (!artifactType || !artifactPath.trim())
    return "Enter an artifact path and type to see a starting command.";
  const localPath = artifactPath.trim();
  const path =
    /^[A-Za-z]:[\\/]/.test(localPath) || localPath.startsWith("\\\\")
      ? quotePowerShell(localPath)
      : quoteShell(localPath);
  switch (artifactType) {
    case "android":
      return `rea inspect-android-package ${path} --json`;
    case "ios":
      return `rea inspect-artifact ${path} --json`;
    case "electron":
      return `rea analyze ${path} --json`;
    case "native":
      return `rea analyze ${path} --provider ghidra --json`;
    default:
      return `rea inspect-artifact ${path} --json`;
  }
};

const asBlock = (input) => {
  const text = input.length > 0 ? input : "Unknown";
  let longestRun = 0;
  for (const match of text.matchAll(/~+/g))
    longestRun = Math.max(longestRun, match[0].length);
  const fence = "~".repeat(Math.max(4, longestRun + 1));
  return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
};
const line = (label, input) => `**${label}**\n\n${asBlock(input)}\n`;

/** Export a readable record while retaining exact source values in fenced blocks. */
export const caseToMarkdown = (researchCase) => {
  const f = researchCase.fields;
  const parts = [
    "# REA security research case",
    "",
    "Policy and scope text below are captured source data. This case is a record, not a testing grant.",
    "",
    line("Created", researchCase.created_at),
    line("Updated", researchCase.updated_at),
    "",
    "## Program and policy",
    "",
    line("Program name", f.programName),
    line("Program URL", f.programUrl),
    line("Program platform", f.programPlatform),
    line("Participation", f.participation),
    line("Participation checked at", f.participationCheckedAt),
    line("Report channel", f.reportChannel),
    line("Disclosure rules", f.disclosureRules),
    line("Policy source URL", f.policyUrl),
    line("Captured at", f.policyCapturedAt),
    line("Policy version or change date", f.policyVersion),
    line("Saved policy copy path", f.policyCopyPath),
    line("Policy text SHA-256", researchCase.policy_sha256),
    line("Exact policy and scope text", f.policyText),
    line("Unresolved policy questions", f.policyUnknowns),
    "## Scope and test rules",
    "",
  ];
  if (researchCase.scopes.length === 0)
    parts.push("No exact scope entries recorded.\n");
  for (const [index, row] of researchCase.scopes.entries()) {
    parts.push(
      `### Scope ${index + 1}`,
      "",
      line("Kind", row.kind),
      line("Exact identifier", row.identifier),
      line("Versions or environment", row.versions),
      line("Policy reference", row.policy_reference),
    );
  }
  parts.push(
    line("Exclusions", f.exclusions),
    line("Allowed techniques", f.allowedTechniques),
    line("Prohibited techniques", f.prohibitedTechniques),
    line("Rate and time limits", f.limits),
    line("Account and data rules", f.accountRules),
    line("Privacy and retention rules", f.privacyRules),
    "## Artifact",
    "",
    line("Type", f.artifactType),
    line("Package or bundle ID", f.artifactIdentifier),
    line("Version and build", f.artifactVersion),
    line("Acquisition source", f.artifactSource),
    line("Acquired at", f.artifactAcquiredAt),
    line("Absolute local path", f.artifactPath),
    line("SHA-256", f.artifactSha256),
    line("Owned test environment", f.testEnvironment),
    line("REA and provider versions", f.providerVersions),
    "## Analysis log",
    "",
    line("Command, target digest, output and Evidence IDs", f.analysisLog),
    "## Finding candidates",
    "",
  );
  if (researchCase.findings.length === 0)
    parts.push("No candidates recorded.\n");
  for (const [index, row] of researchCase.findings.entries()) {
    parts.push(
      `### Candidate ${index + 1}`,
      "",
      line("ID", row.id),
      line("Title", row.title),
      line("Entry point, check, and affected operation", row.entry_point),
      line("Observation and source location", row.observation),
      line("REA Evidence references", row.evidence_refs),
      line("Inference and competing explanations", row.inference),
      line("Unknowns", row.unknowns),
      line("Controlled reproduction", row.reproduction),
      line("Observed impact", row.impact),
    );
  }
  return parts.join("\n").trimEnd() + "\n";
};
