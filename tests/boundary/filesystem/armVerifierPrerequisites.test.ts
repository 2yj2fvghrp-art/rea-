import { describe, expect, it } from "vitest";
import { selectArmObjcopy } from "../../../scripts/lib/arm-objcopy.mjs";

describe("ARM verifier objcopy prerequisite", () => {
  it("selects the first available executable before verifier setup", async () => {
    const attempts: string[] = [];
    const selected = await selectArmObjcopy(
      ["missing-objcopy", "working-objcopy"],
      async (command) => {
        attempts.push(command);
        if (command === "missing-objcopy") throw new Error("not found");
      },
    );

    expect(selected).toBe("working-objcopy");
    expect(attempts).toEqual(["missing-objcopy", "working-objcopy"]);
  });

  it("fails with an actionable prerequisite error when none are available", async () => {
    await expect(
      selectArmObjcopy(["missing-objcopy"], async () => {
        throw new Error("not found");
      }),
    ).rejects.toThrow("Missing prerequisite: llvm-objcopy or GNU objcopy");
  });
});
