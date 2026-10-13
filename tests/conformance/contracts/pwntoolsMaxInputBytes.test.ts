import { describe, expect, it } from "vitest";

import {
  parsePwntoolsMaxInputBytes,
  pwntoolsMaxInputBytesSchema,
} from "../../../src/config/pwntoolsMaxInputBytes.js";
import { parseEnvironment } from "../../../src/config/environment.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { PWNTOOLS_LIMITS } from "../../../src/native/pwntools/PwntoolsRelease.js";

describe("pwntools max input bytes configuration", () => {
  it("defaults to PWNTOOLS_LIMITS.inputBytes when unset or empty", () => {
    expect(parsePwntoolsMaxInputBytes(undefined)).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
    expect(parsePwntoolsMaxInputBytes("")).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
  });

  it("parses valid positive decimal safe integers", () => {
    // 64 MiB
    expect(parsePwntoolsMaxInputBytes("67108864")).toEqual({
      ok: true,
      value: 67_108_864,
    });
    // 256 MiB
    expect(parsePwntoolsMaxInputBytes("268435456")).toEqual({
      ok: true,
      value: 268_435_456,
    });
    // 1 GiB
    expect(parsePwntoolsMaxInputBytes("1073741824")).toEqual({
      ok: true,
      value: 1_073_741_824,
    });
    // Minimum 1 byte
    expect(parsePwntoolsMaxInputBytes("1")).toEqual({
      ok: true,
      value: 1,
    });
  });

  it.each([
    "0",
    "-1",
    "-1024",
    "1.5",
    "abc",
    "0123",
    "1e8",
    " 33554432",
    "33554432 ",
    "9007199254740992", // > Number.MAX_SAFE_INTEGER
  ])("rejects malformed or unsafe values: %j", (value) => {
    const result = parsePwntoolsMaxInputBytes(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("REA_PWNTOOLS_MAX_INPUT_BYTES");
      expect(result.error.settings).toEqual([
        {
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
          constraint:
            "REA_PWNTOOLS_MAX_INPUT_BYTES must be a positive decimal safe integer.",
        },
      ]);
    }
  });

  it("exports pwntoolsMaxInputBytesSchema for composition in environmentSchema", () => {
    expect(pwntoolsMaxInputBytesSchema.safeParse("268435456").success).toBe(
      true,
    );
    expect(pwntoolsMaxInputBytesSchema.safeParse("0").success).toBe(false);
  });

  it("integrates with parseEnvironment and parseConfig", () => {
    const validEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "268435456",
    });
    expect(validEnv.ok).toBe(true);
    if (validEnv.ok) {
      expect(validEnv.value.REA_PWNTOOLS_MAX_INPUT_BYTES).toBe(268_435_456);
    }

    const invalidEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "invalid-bytes",
    });
    expect(invalidEnv.ok).toBe(false);
    if (!invalidEnv.ok) {
      expect(invalidEnv.error.settings).toEqual([
        expect.objectContaining({
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
        }),
      ]);
    }

    const configResult = parseConfig({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "536870912", // 512 MiB
    });
    expect(configResult.ok).toBe(true);
  });
});
