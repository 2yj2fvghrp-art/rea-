export interface GhidraVerifierTimeouts {
  readonly clientOptions: {
    readonly startupTimeoutMs: number;
  };
  readonly publicRequestTimeoutMs: number;
}

/** Resolve one verifier-owned timeout policy before target I/O or allocation. */
export function resolveGhidraVerifierTimeouts(
  environment: Readonly<Record<string, string | undefined>>,
): GhidraVerifierTimeouts;
