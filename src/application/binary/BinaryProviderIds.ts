/**
 * Provider ids served by the binary `analyze` lane (`open_binary` and the
 * one-shot native commands). JEB inspects projects through its dedicated
 * commands instead.
 *
 * This value lives in a dependency-light module because CLI setup rendering
 * needs the lane distinction at startup, while the provider implementations
 * stay behind deferred imports (see `tests/boundary/cli/cliStartupImports`).
 * Keep it aligned with the registry wiring in `composition/binary.ts`.
 */
export const BINARY_ANALYSIS_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "hopper",
  "ghidra",
  "ida",
]);
