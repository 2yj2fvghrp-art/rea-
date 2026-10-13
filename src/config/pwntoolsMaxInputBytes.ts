import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { PWNTOOLS_LIMITS } from "../native/pwntools/PwntoolsRelease.js";

/** Positive decimal safe integer input budget override. */
export const pwntoolsMaxInputBytesSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "must be a positive decimal integer")
  .transform(Number)
  .pipe(z.number().int().safe().min(1));

const budgetConstraint =
  "REA_PWNTOOLS_MAX_INPUT_BYTES must be a positive decimal safe integer.";

/** Parse the optional pwntools input budget setting without reading the ambient process environment. */
export const parsePwntoolsMaxInputBytes = (
  value: string | undefined,
): Result<number, ConfigurationError> => {
  if (value === undefined || value === "")
    return ok(PWNTOOLS_LIMITS.inputBytes);
  const parsed = pwntoolsMaxInputBytesSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(budgetConstraint, {
          settings: [
            {
              setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
              constraint: budgetConstraint,
            },
          ],
        }),
      );
};
