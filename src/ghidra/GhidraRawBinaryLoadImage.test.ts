import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attestGhidraRawBinaryLoadImage } from "./GhidraLoadImageValues.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const fixture = (): {
  bytes: Buffer;
  target: Extract<BinaryTarget, { format: "raw-binary" }>;
  observation: NativeLoadImageObservation;
} => {
  const bytes = Buffer.from("1eff2fe1", "hex");
  const digest = hash(bytes);
  return {
    bytes,
    target: {
      path: "/tmp/ecu.bin",
      sha256: digest,
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      entryPoint: "0x8000000",
      entryPointSource: "0x08000000",
    },
    observation: {
      executable_format: "Raw Binary",
      language_id: "ARM:LE:32:v7",
      compiler_spec_id: "default",
      image_base: "0x0",
      default_address_space: "ram",
      source_files: [
        {
          name: "ecu.bin",
          size: bytes.length,
          original_sha256: digest,
          modified_sha256: digest,
        },
      ],
      mappings: [
        {
          block: "ram",
          start: "0x8000000",
          end: "0x8000003",
          address_space: "ram",
          initialized: true,
          loaded: true,
          overlay: false,
          length: bytes.length,
          source_file_index: 0,
          file_offset: 0,
          sha256: digest,
        },
      ],
      relocations: [],
      entry_points: ["0x8000000"],
      entry_context: [],
    },
  };
};

describe("raw-binary Ghidra language binding", () => {
  it("maps the four admitted families to little-endian generic languages", () => {
    expect(ghidraRawBinaryLanguage("x86")).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "default",
    });
    expect(ghidraRawBinaryLanguage("x86_64")).toEqual({
      languageId: "x86:LE:64:default",
      compilerSpecId: "default",
    });
    expect(ghidraRawBinaryLanguage("arm")).toEqual({
      languageId: "ARM:LE:32:v7",
      compilerSpecId: "default",
    });
    expect(ghidraRawBinaryLanguage("arm64")).toEqual({
      languageId: "AARCH64:LE:64:v8A",
      compilerSpecId: "default",
    });
  });
});

describe("raw-binary independent load-image checks", () => {
  it("verifies mapped bytes at the caller-supplied entry", () => {
    const f = fixture();
    const result = attestGhidraRawBinaryLoadImage(
      f.bytes,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        format: "raw-binary",
        architecture: "arm",
        language_id: "ARM:LE:32:v7",
        base_address: "0x8000000",
        file_bytes: 4,
        entry: { address: "0x8000000", file_offset: 0 },
      },
    });
  });
  it("retains mismatch evidence for a drifted language", () => {
    const f = fixture();
    f.observation.language_id = "x86:LE:32:default";
    const result = attestGhidraRawBinaryLoadImage(
      f.bytes,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: "mismatch", observations: f.observation },
    });
  });
  it("preserves additional language entries while requiring the caller entry", () => {
    const f = fixture();
    f.observation.entry_points = ["0x0", f.target.entryPoint, "0xffff0000"];
    expect(
      attestGhidraRawBinaryLoadImage(f.bytes, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: { status: "verified", observations: f.observation },
    });
    f.observation.entry_points = ["0x0", "0xffff0000"];
    expect(
      attestGhidraRawBinaryLoadImage(f.bytes, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "entry_point",
            matched: false,
            observed: null,
          }),
        ]),
      },
    });
  });
  it("rejects stale snapshot identity", () => {
    const f = fixture();
    expect(
      attestGhidraRawBinaryLoadImage(
        f.bytes,
        { ...f.target, sha256: "f".repeat(64) },
        f.observation,
      ).ok,
    ).toBe(false);
  });
});
