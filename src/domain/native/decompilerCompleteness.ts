import { z } from "zod";

/** Provider-reported diagnostics; silence does not prove complete decompilation. */
export const decompilerCompletenessSchema = z
  .strictObject({
    status: z.enum(["warnings", "no-warnings-reported", "unavailable"]),
    provenance: z.literal("ghidra-decompiler-warning-observations"),
    warning_count: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    diagnostic: z.string().min(1).nullable(),
    dropped_blocks: z.array(
      z.strictObject({
        start: z.string().min(1).nullable(),
        end: z.null(),
        address_space: z.string().min(1),
        reason: z.literal("unreachable"),
        warning_index: z.number().int().nonnegative(),
      }),
    ),
    disassembly_available: z.boolean(),
  })
  .superRefine((value, context) => {
    const warned = value.warnings.length > 0 || value.diagnostic !== null;
    if (
      value.warning_count !== value.warnings.length ||
      (value.status === "warnings") !== warned ||
      value.dropped_blocks.some(
        (block) => block.warning_index >= value.warnings.length,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Decompiler diagnostic counts or status are inconsistent",
      });
  });
