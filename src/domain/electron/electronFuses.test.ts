import { describe, expect, it } from "vitest";

import {
  describeElectronFuseFindings,
  electronFuseName,
  electronFuseReportSchema,
  electronFuseState,
  ELECTRON_FUSE_SENTINEL,
  ELECTRON_FUSE_STATE_BYTES,
  ELECTRON_FUSE_V1_NAMES,
  type ElectronFuseSlice,
} from "./electronFuses.js";

const artifact = {
  selected_path: "/artifacts/Electron",
  resolved_path: "/artifacts/Electron",
  sha256: "a".repeat(64),
  bytes: 128,
  format: "mach-o" as const,
};

const sentinel = (
  offset: number,
  fuses: readonly number[],
  options?: {
    readonly version?: number | null;
    readonly declared?: number | null;
    readonly complete?: boolean;
  },
) => ({
  sentinel_offset: offset,
  wire_version: options?.version === undefined ? 1 : options.version,
  declared_length:
    options?.declared === undefined ? fuses.length : options.declared,
  fuses: fuses.map((raw, index) => ({
    index,
    name: electronFuseName(
      options?.version === undefined ? 1 : (options.version ?? 1),
      index,
    ),
    state: electronFuseState(raw),
    raw_byte: raw,
  })),
  complete: options?.complete ?? true,
});

const slice = (
  sentinels: ReturnType<typeof sentinel>[],
  index = 0,
): ElectronFuseSlice => ({
  index,
  file_offset: 0,
  size: 128,
  architecture: "arm64",
  sentinel_count: sentinels.length,
  sentinels,
});

describe("Electron fuse wire decoding", () => {
  it("keeps the 32-byte sentinel and version-1 names pinned", () => {
    expect(ELECTRON_FUSE_SENTINEL).toHaveLength(32);
    expect(ELECTRON_FUSE_V1_NAMES[3]).toBe("EnableNodeCliInspectArguments");
    expect(electronFuseName(1, 8)).toBe("WasmTrapHandlers");
    expect(electronFuseName(1, 9)).toBeNull();
    expect(electronFuseName(2, 0)).toBeNull();
  });

  it("preserves disabled, enabled, removed, and unknown bytes", () => {
    expect(electronFuseState(ELECTRON_FUSE_STATE_BYTES.disabled)).toBe(
      "disabled",
    );
    expect(electronFuseState(ELECTRON_FUSE_STATE_BYTES.enabled)).toBe(
      "enabled",
    );
    expect(electronFuseState(ELECTRON_FUSE_STATE_BYTES.removed)).toBe(
      "removed",
    );
    expect(electronFuseState(0x99)).toBe("unknown");
  });

  it("derives runtime implications from the fuse index and leaves unknowns unknown", () => {
    const fuses = [
      ELECTRON_FUSE_STATE_BYTES.disabled,
      ELECTRON_FUSE_STATE_BYTES.enabled,
      0x99,
      ELECTRON_FUSE_STATE_BYTES.removed,
      ELECTRON_FUSE_STATE_BYTES.disabled,
      ELECTRON_FUSE_STATE_BYTES.enabled,
    ];
    const report = electronFuseReportSchema.parse({
      artifact,
      slices: [slice([sentinel(8, fuses)])],
      ...describeElectronFuseFindings([slice([sentinel(8, fuses)])]),
    });
    expect(report.runtime_implications).toEqual([
      expect.objectContaining({
        subject: "node_cli_inspect_arguments",
        fuse_index: 3,
        outcome: "not_honored",
        relationship: "derivation",
      }),
      expect.objectContaining({
        subject: "electron_run_as_node",
        fuse_index: 0,
        outcome: "not_honored",
      }),
      expect.objectContaining({
        subject: "embedded_asar_integrity_validation",
        fuse_index: 4,
        outcome: "not_enforced",
      }),
      expect.objectContaining({
        subject: "only_load_app_from_asar",
        fuse_index: 5,
        outcome: "restricted_to_app_asar",
      }),
    ]);
    expect(report.slices[0] !== undefined && "fuses" in report.slices[0]).toBe(
      false,
    );
    expect(report.slices[0]?.sentinels[0]?.fuses[2]).toMatchObject({
      index: 2,
      name: "EnableNodeOptionsEnvironmentVariable",
      state: "unknown",
      raw_byte: 0x99,
    });
  });

  it("does not treat a missing sentinel or a short wire as disabled fuses", () => {
    const missing = describeElectronFuseFindings([slice([])]);
    expect(missing.runtime_implications).toEqual([]);
    expect(missing.limitations.join(" ")).toContain(
      "unknown, not that every fuse is disabled",
    );
    expect(missing.limitations.join(" ")).toContain(
      "fuse state for that slice is unknown, not disabled",
    );
    const truncated = describeElectronFuseFindings([
      slice([
        sentinel(8, [ELECTRON_FUSE_STATE_BYTES.enabled], {
          declared: 4,
          complete: false,
        }),
      ]),
    ]);
    expect(truncated.runtime_implications).toEqual([
      expect.objectContaining({
        subject: "electron_run_as_node",
        outcome: "honored",
      }),
    ]);
    expect(truncated.limitations.join(" ")).toContain("truncated");
    expect(truncated.limitations.join(" ")).toContain("fuse index 3");
  });

  it("reports every sentinel and skips implications for an unpinned wire version", () => {
    const findings = describeElectronFuseFindings([
      slice([
        sentinel(8, [ELECTRON_FUSE_STATE_BYTES.enabled], { version: 2 }),
        sentinel(
          40,
          Array.from({ length: 6 }, () => ELECTRON_FUSE_STATE_BYTES.disabled),
        ),
      ]),
    ]);
    expect(findings.runtime_implications).toHaveLength(4);
    expect(findings.limitations.join(" ")).toContain("none is selected");
    expect(findings.limitations.join(" ")).toContain("wire version 2");
    expect(
      findings.runtime_implications.every(
        (item) => item.sentinel_offset === 40,
      ),
    ).toBe(true);
  });
});
