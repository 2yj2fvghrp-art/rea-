import { createHash } from "node:crypto";
import { z } from "zod";

const UDID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** One exact, already-booted iOS Simulator selected by CoreSimulator UDID. */
export const iosSimulatorCaptureInputSchema = z.strictObject({
  simulator_udid: z
    .string()
    .regex(UDID)
    .describe(
      "Exact iOS Simulator UDID; aliases such as booted are not accepted",
    ),
});
export type IosSimulatorCaptureInput = z.infer<
  typeof iosSimulatorCaptureInputSchema
>;

const screenshotSchema = z
  .strictObject({
    mime_type: z.literal("image/png"),
    base64: z.string().min(4),
    sha256: z.string().regex(DIGEST),
    byte_length: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .superRefine((screenshot, context) => {
    const bytes = Buffer.from(screenshot.base64, "base64");
    const dimensions = parsePngDimensions(bytes);
    if (bytes.toString("base64") !== screenshot.base64 || dimensions === null) {
      context.addIssue({
        code: "custom",
        message: "Screenshot lacks complete canonical PNG chunk structure",
      });
      return;
    }
    if (
      bytes.length !== screenshot.byte_length ||
      createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256 ||
      dimensions.width !== screenshot.width ||
      dimensions.height !== screenshot.height
    )
      context.addIssue({
        code: "custom",
        message: "Screenshot bytes, digest or dimensions mismatch",
      });
  });

/** A simulator display is observed; application attribution is unavailable. */
export const iosSimulatorCaptureResultSchema = z.strictObject({
  simulator: z.strictObject({
    udid: z.string().regex(UDID),
    name: z.string(),
    runtime_id: z.string(),
    device_type_id: z.string(),
    state: z.literal("Booted"),
  }),
  screenshot: screenshotSchema,
  foreground_application: z.null(),
  captured_at: z.iso.datetime(),
  limitations: z.array(z.string()),
});
export type IosSimulatorCaptureResult = z.infer<
  typeof iosSimulatorCaptureResultSchema
>;

/** Validate PNG chunk structure, without claiming CRC or pixel decode validity. */
export const parsePngDimensions = (
  bytes: Buffer,
): { width: number; height: number } | null => {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return null;
  let offset = 8;
  let dimensions: { width: number; height: number } | null = null;
  let ended = false;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (dimensions === null) {
      if (kind !== "IHDR" || length !== 13) return null;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) return null;
      dimensions = { width, height };
    } else if (kind === "IHDR") return null;
    if (kind === "IDAT") imageData = true;
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.length) return null;
      ended = true;
      break;
    }
    offset = end;
  }
  return ended && imageData ? dimensions : null;
};
