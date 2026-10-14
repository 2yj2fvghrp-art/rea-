import { z } from "incur";
import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { parseConfig } from "../config/parseConfig.js";
import type { GhidraProjectCacheConfig } from "../config/ghidraProjectCache.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { GhidraProjectStore } from "../ghidra/projectCache/GhidraProjectStore.js";
import type { CliInstance } from "./types.js";

/**
 * Inspect and maintain the managed Ghidra project cache. These commands are
 * read-only discovery plus explicit maintenance; they never open a target.
 */
export const registerCacheCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const configured = parseConfig(environment);
  const failure = (error: string) =>
    configured.ok
      ? undefined
      : { error, ...projectAnalysisError(configured.error) };
  const storeFor = (config: GhidraProjectCacheConfig): GhidraProjectStore =>
    new GhidraProjectStore({
      root: config.directory,
      maxBytes: config.maxBytes,
    });

  cli.command(CLI_COMMANDS.cacheList, {
    description: "List stored Ghidra projects reusable across sessions",
    run: () =>
      logCliCommand(logger, CLI_COMMANDS.cacheList, async () => {
        const failed = failure("Cache listing failed");
        if (failed !== undefined) return failed;
        if (!configured.ok) return failed;
        const config = configured.value.ghidraProjectCache;
        const entries = await storeFor(config).list();
        return {
          cache_directory: config.directory,
          mode: config.mode,
          max_bytes: config.maxBytes,
          entry_count: entries.length,
          total_bytes: entries.reduce(
            (total, entry) => total + entry.size_bytes,
            0,
          ),
          entries: entries.map((entry) => ({
            key: entry.key,
            program_name: entry.program_name,
            target_sha256: entry.target.sha256,
            provider_version: entry.provider.version,
            size_bytes: entry.size_bytes,
            created_at: entry.created_at,
          })),
        };
      }),
  });

  cli.command(CLI_COMMANDS.cachePrune, {
    description:
      "Remove the oldest stored Ghidra projects beyond the size ceiling",
    run: () =>
      logCliCommand(logger, CLI_COMMANDS.cachePrune, async () => {
        const failed = failure("Cache prune failed");
        if (failed !== undefined) return failed;
        if (!configured.ok) return failed;
        const config = configured.value.ghidraProjectCache;
        const pruned = await storeFor(config).prune();
        return {
          cache_directory: config.directory,
          max_bytes: config.maxBytes,
          removed_keys: pruned.removed,
          freed_bytes: pruned.bytes,
        };
      }),
  });

  cli.command(CLI_COMMANDS.cacheRemove, {
    description: "Remove one stored Ghidra project by key",
    args: z.object({
      key: z.string().describe("Cache entry key reported by cache-list"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.cacheRemove, async () => {
        const failed = failure("Cache removal failed");
        if (failed !== undefined) return failed;
        if (!configured.ok) return failed;
        const config = configured.value.ghidraProjectCache;
        const removed = await storeFor(config).remove(args.key);
        if (!removed.ok)
          return {
            error: "Cache removal failed",
            diagnostics: removed.error.diagnostics,
          };
        return {
          cache_directory: config.directory,
          key: args.key,
          removed: removed.value,
        };
      }),
  });
};
