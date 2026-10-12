import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
} from "./browserObservation.js";
import { browserCompletenessSchema } from "./browserCompleteness.js";
import { browserVersionSchema } from "./browserObservationSchemas.js";
import { jsonValueSchema } from "./jsonValue.js";

const observeWebSessionNetworkSchema = z
  .strictObject({
    header_values: z
      .boolean()
      .default(false)
      .describe(
        "Retain request and response headers; transport credentials are always omitted.",
      ),
  })
  .describe(
    "Record in-scope HTTP and WebSocket traffic from the selected page as one HAR 1.2 log. Omit to retain navigation metadata only.",
  );

/**
 * Reserved host (RFC 2606) that replaces a URL host spelling a declared
 * sensitive value, so the redacted URL stays parseable.
 */
export const REDACTED_URL_HOST = "redacted.invalid";

/**
 * True when redaction replaced a URL's host or emptied its port, so the URL
 * names no real origin. Browsers never serialize an empty port.
 */
export const hasRedactedUrlAuthority = (url: string): boolean =>
  URL.canParse(url) &&
  (new URL(url).hostname === REDACTED_URL_HOST ||
    /^[^:/?#]+:\/\/[^/?#]*:(?![^/?#])/u.test(url));

/** Input for a navigation-aware browser observation window. */
export const observeWebSessionInputSchema = z.strictObject({
  cdp_endpoint: browserEndpointSchema,
  allowed_origins: browserAllowedOriginsSchema,
  target_id: z.string().trim().min(1),
  observation_ms: z.number().int().min(1).default(10_000),
  network: observeWebSessionNetworkSchema.optional(),
  sensitive_values: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal text replaced in every retained URL, header and timeline field. Never persisted in Evidence parameters; only the count is.",
    ),
  sensitive_query_parameters: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Exact query parameter names whose values, observed in the query string of a retained URL, are replaced wherever they appear in the result. Parameters inside a URL fragment are not read; declare those values in sensitive_values. Names alone never establish sensitivity otherwise.",
    ),
});
export type ObserveWebSessionInput = z.infer<
  typeof observeWebSessionInputSchema
>;

const timelineEventSchema = z.object({
  sequence: z.number().int().min(1),
  type: z.enum([
    "navigation_requested",
    "navigation_committed",
    "same_origin_reload",
    "same_document_navigation",
    "redirect",
    "load_failed",
    "lifecycle",
    "target_terminated",
  ]),
  timestamp: z.number().min(0),
  frame_id: z.string().nullable(),
  loader_id: z.string().nullable(),
  request_id: z.string().nullable(),
  url: z.string().nullable(),
  destination_scope: z
    .enum(["approved", "outside_policy", "unsupported"])
    .nullable(),
  detail: z.string().nullable(),
});

const harObjectSchema = z.record(z.string(), jsonValueSchema);

/** HAR 1.2 network evidence recorded during one observation window. */
export const webSessionNetworkSchema = z.object({
  har: z.object({
    log: z.object({
      version: z.literal("1.2"),
      creator: z.object({ name: z.string(), version: z.string() }),
      browser: z.object({ name: z.string(), version: z.string() }),
      entries: z.array(harObjectSchema),
    }),
  }),
  har_bytes: z
    .number()
    .int()
    .min(0)
    .describe("UTF-8 bytes of the compact JSON serialization of har."),
  targets: z
    .array(
      z.object({
        target_id: z.string(),
        type: z.enum(["page"]),
        url: z.string().nullable(),
      }),
    )
    .describe(
      "Observed targets; HAR entries reference them by _rea_target_id.",
    ),
  redactions: z.object({
    transport_credential_headers: z
      .number()
      .int()
      .min(0)
      .describe(
        "Authorization, Proxy-Authorization, Cookie and Set-Cookie headers omitted, plus URL-valued headers whose userinfo was removed.",
      ),
    out_of_scope_url_headers: z
      .number()
      .int()
      .min(0)
      .describe(
        "URL-valued headers (Location, Content-Location, Referer, Origin, Link, Refresh) omitted because a target was outside the selected origins or could not be parsed.",
      ),
    explicit_value_fields: z
      .number()
      .int()
      .min(0)
      .describe(
        "HAR and network target fields changed by declared sensitive values or observed sensitive query parameter values: URLs, query parameter names and values, header names and values, methods, status texts, MIME types, resource types and target IDs, including those of HAR entries later omitted. The top-level browser, target and timeline fields are redacted the same way but not counted.",
      ),
  }),
  coverage_started_at: z.iso.datetime(),
  prior_activity_available: z.literal(false),
});
export type WebSessionNetwork = z.infer<typeof webSessionNetworkSchema>;

/** Navigation-aware session result for external user actions. */
export const webObservationSessionSchema = z.object({
  browser: browserVersionSchema,
  target: z.object({
    target_id: z.string(),
    initial_url: z.string(),
    final_url: z.string().nullable(),
  }),
  window: z.object({
    armed_at: z.iso.datetime(),
    ended_at: z.iso.datetime(),
    requested_ms: z.number().int().min(1),
    end_reason: z.enum([
      "window_elapsed",
      "target_left_scope",
      "target_terminated",
    ]),
  }),
  timeline: z.array(timelineEventSchema),
  network: webSessionNetworkSchema
    .optional()
    .describe("Present only when network capture was requested."),
  completeness: browserCompletenessSchema,
  limitations: z.array(z.string()),
});
export type WebObservationSession = z.infer<typeof webObservationSessionSchema>;
