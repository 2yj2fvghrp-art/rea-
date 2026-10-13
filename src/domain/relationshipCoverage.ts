import { z } from "zod";

const diagnostics = z.array(z.string().min(1)).min(1);
const completeCoverage = z.strictObject({ status: z.literal("complete") });
const limitedDirections = z.union([
  z.tuple([z.literal("callers")]).check(z.minLength(1), z.maxLength(1)),
  z.tuple([z.literal("callees")]).check(z.minLength(1), z.maxLength(1)),
  z
    .tuple([z.literal("callers"), z.literal("callees")])
    .check(z.minLength(2), z.maxLength(2)),
]);
const partialCoverage = z.strictObject({
  status: z.literal("partial"),
  limitations: z.array(z.string().min(1)).min(1),
  limited_directions: limitedDirections.exactOptional(),
});
const unknownCoverage = z.strictObject({
  status: z.literal("unknown"),
  reason: z.string().min(1),
  limited_directions: limitedDirections.exactOptional(),
});

/** Explicit coverage state for a provider's observed caller/callee set. */
export const relationshipCoverageSchema = z.union([
  completeCoverage,
  completeCoverage.extend({ diagnostics }),
  partialCoverage,
  partialCoverage.extend({ diagnostics }),
  unknownCoverage,
  unknownCoverage.extend({ diagnostics }),
]);

export type RelationshipCoverage = z.infer<typeof relationshipCoverageSchema>;
