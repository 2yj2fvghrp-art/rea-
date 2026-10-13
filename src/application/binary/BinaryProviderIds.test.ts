import { expect, it } from "vitest";
import { DOCTOR_PROVIDER_IDS } from "../DoctorProviderIds.js";
import { BINARY_ANALYSIS_PROVIDER_IDS } from "./BinaryProviderIds.js";

/** The binary `analyze` lane serves every doctor provider except JEB's dedicated lane. */
it("tracks the binary-lane doctor providers", () => {
  expect(new Set(BINARY_ANALYSIS_PROVIDER_IDS)).toEqual(
    new Set(DOCTOR_PROVIDER_IDS.filter((id) => id !== "jeb")),
  );
});
