export const selectArmObjcopy = async (candidates, execute) => {
  for (const candidate of candidates) {
    try {
      await execute(candidate, ["--version"], { timeout: 10000 });
      return candidate;
    } catch {
      // Continue through caller-selected and standard executable names.
    }
  }
  throw new Error(
    "Missing prerequisite: llvm-objcopy or GNU objcopy (set REA_ARM_OBJCOPY)",
  );
};
