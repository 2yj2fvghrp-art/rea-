import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import { ConfigurationError } from "../domain/configurationErrors.js";

/** One language definition and the compiler specs it declares. */
export interface GhidraLanguageDefinition {
  readonly id: string;
  readonly compilerSpecIds: readonly string[];
}

// Language definitions are small XML files; refuse anything implausibly large.
const MAX_LDEFS_BYTES = 4 * 1024 * 1024;
// Processor modules ship under Processors; installed extensions may add more.
const LANGUAGE_ROOTS = ["Ghidra/Processors", "Ghidra/Extensions"] as const;

const attribute = (element: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "u").exec(element)?.[1];

/** Parse the `<language>` elements of one `.ldefs` document. */
export const parseGhidraLanguageDefinitions = (
  text: string,
): readonly GhidraLanguageDefinition[] => {
  const definitions: GhidraLanguageDefinition[] = [];
  for (const block of text.matchAll(
    /<language\b([^>]*)>([\s\S]*?)<\/language>/gu,
  )) {
    const id = attribute(block[1] ?? "", "id");
    if (id === undefined) continue;
    const compilerSpecIds = [
      ...(block[2] ?? "").matchAll(/<compiler\b([^>]*)\/?>/gu),
    ]
      .map((compiler) => attribute(compiler[1] ?? "", "id"))
      .filter((value): value is string => value !== undefined);
    definitions.push({ id, compilerSpecIds });
  }
  return definitions;
};

const languageDirectories = async (installDir: string): Promise<string[]> => {
  const directories: string[] = [];
  for (const root of LANGUAGE_ROOTS) {
    let modules: string[];
    try {
      modules = await readdir(join(installDir, root));
    } catch {
      continue;
    }
    for (const module of modules.sort())
      directories.push(join(installDir, root, module, "data", "languages"));
  }
  return directories;
};

/** Read every language definition shipped by one Ghidra installation. */
export const readGhidraLanguageCatalog = async (
  installDir: string,
): Promise<readonly GhidraLanguageDefinition[]> => {
  const definitions: GhidraLanguageDefinition[] = [];
  for (const directory of await languageDirectories(installDir)) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".ldefs")) continue;
      const bytes = await readFile(join(directory, entry));
      if (bytes.length > MAX_LDEFS_BYTES) continue;
      definitions.push(
        ...parseGhidraLanguageDefinitions(bytes.toString("utf8")),
      );
    }
  }
  return definitions;
};

/**
 * Check a configured import language against the installation before launch,
 * so an unknown ID fails as configuration instead of as a failed import.
 */
export const admitGhidraLanguageOverride = (
  override: GhidraLanguageOverride,
  catalog: readonly GhidraLanguageDefinition[],
  providerVersion: string,
): ConfigurationError | null => {
  const language = catalog.find((value) => value.id === override.languageId);
  if (language === undefined)
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_LANGUAGE_ID",
          constraint: `is not a language defined by Ghidra ${providerVersion}`,
        },
      ],
    });
  if (
    override.compilerSpecId !== undefined &&
    !language.compilerSpecIds.includes(override.compilerSpecId)
  )
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_COMPILER_SPEC_ID",
          constraint: `must be one of the selected language's compiler specs: ${language.compilerSpecIds.join(", ")}`,
        },
      ],
    });
  return null;
};
