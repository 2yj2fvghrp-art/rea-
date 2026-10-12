/** Exact upstream release whose producer output is admitted by this adapter. */
export const WABT_PROVIDER_IDENTITY = {
  id: "wabt-artifact",
  name: "REA WABT artifact adapter",
  version: "wabt@1.0.42",
} as const;
export const WABT_LIMITS = {
  inputBytes: 8 * 1024 * 1024,
  toolBytes: 64 * 1024 * 1024,
  // Real public npm modules decode to large WAT: resvg-wasm 2.4 MiB to about
  // 53 MB, rapier3d 2.9 MiB to about 77 MB and canvaskit 7.0 MiB to about
  // 83 MB. 128 MiB leaves headroom; larger output still fails closed.
  outputBytes: 128 * 1024 * 1024,
  timeoutMs: 30_000,
} as const;
