import { createHash } from "node:crypto";

import type { BrowserScenario } from "../domain/browserScenario.js";
import type {
  BrowserScenarioUrl,
  BrowserScenarioValue,
} from "../domain/browserScenarioValues.js";
import {
  sanitizeBrowserUrl,
  type SanitizedBrowserUrl,
} from "../domain/browserObservation.js";
import type { BrowserStorageValueFingerprint } from "../domain/browserScenarioCaptureValues.js";

const REDACTION_PREFIX = "[REDACTED:";

const encodedSecretValues = (secret: string): ReadonlySet<string> =>
  new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams([["value", secret]]).toString().slice("value=".length),
  ]);

const htmlSecretValues = (secret: string): readonly string[] => {
  const escaped = secret
    .replaceAll("&", "&amp;")
    .replaceAll("\u00a0", "&nbsp;");
  const text = escaped.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    secret,
    text,
    escaped.replaceAll('"', "&quot;"),
    text.replaceAll('"', "&quot;"),
  ];
};

const artifactSecretPatterns = (secret: string): readonly string[] => {
  const uriSpellings = [
    new URLSearchParams([["value", secret]]).toString().slice("value=".length),
  ];
  try {
    uriSpellings.push(encodeURIComponent(secret), encodeURI(secret));
  } catch (cause: unknown) {
    // URI encoders reject lone surrogates; raw/HTML and form spellings still exist.
    if (!(cause instanceof URIError)) throw cause;
  }
  const spellings = [
    { text: secret, encoded: false },
    ...uriSpellings
      .filter((text) => text !== secret)
      .map((text) => ({ text, encoded: true })),
  ];
  return [
    ...new Set(
      spellings.flatMap(({ text, encoded }) =>
        htmlSecretValues(text).map((spelling) => {
          const literal = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // URI hex digits are case-insensitive; the surrounding text is not.
          return encoded
            ? literal.replace(/%[\dA-F]{2}/g, (escape) =>
                escape.replace(
                  /[A-F]/g,
                  (digit) => `[${digit}${digit.toLowerCase()}]`,
                ),
              )
            : literal;
        }),
      ),
    ),
  ];
};

type SecretSpellings = "raw" | "url" | "bytes";

const secretSpellings = (
  secret: string,
  spellings: SecretSpellings,
): readonly string[] => {
  if (secret === "") return [];
  if (spellings === "raw") return [secret];
  const values = [...encodedSecretValues(secret)];
  if (spellings === "bytes") values.push(JSON.stringify(secret).slice(1, -1));
  return [...new Set(values)].filter((value) => value !== "");
};

const declaredLiterals = (
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
): readonly string[] => [
  ...new Set(
    [...values.values()].flatMap((secret) =>
      secretSpellings(secret, spellings),
    ),
  ),
];

/** Pick a marker that does not itself contain a declared secret spelling. */
const redactionMarker = (id: string, literals: readonly string[]): string =>
  [`${REDACTION_PREFIX}${id}]`, "[REDACTED]", "…", ""].find((candidate) =>
    literals.every((literal) => !candidate.includes(literal)),
  ) ?? "";

const replaceSecretLiterals = (
  value: string,
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
  literals: readonly string[],
): string => {
  const replacements = [...values]
    .flatMap(([id, secret]) =>
      secretSpellings(secret, spellings).map((text) => ({ id, text })),
    )
    .sort(
      (left, right) =>
        right.text.length - left.text.length ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  let output = value;
  for (const replacement of replacements)
    output = output.replaceAll(
      replacement.text,
      redactionMarker(replacement.id, literals),
    );
  return output;
};

const secretNeedles = (
  values: ReadonlyMap<string, string>,
  literals: readonly string[],
): Array<{
  readonly id: string;
  readonly needle: Buffer;
  readonly marker: Buffer;
}> =>
  [...values].flatMap(([id, secret]) =>
    secretSpellings(secret, "bytes").map((text) => ({
      id,
      needle: Buffer.from(text),
      marker: Buffer.from(redactionMarker(id, literals)),
    })),
  );

/** Resolved secret values kept only for one in-memory scenario session. */
export class BrowserScenarioSecrets {
  private constructor(private readonly values: ReadonlyMap<string, string>) {}

  static resolve(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
  ): BrowserScenarioSecrets | undefined {
    const values = new Map<string, string>();
    for (const declaration of scenario.secrets) {
      const value = environment[declaration.environment_variable];
      if (
        !Object.hasOwn(environment, declaration.environment_variable) ||
        typeof value !== "string"
      )
        return undefined;
      values.set(declaration.secret_id, value);
    }
    return new BrowserScenarioSecrets(values);
  }

  value(source: BrowserScenarioValue): string {
    if (source.source === "literal") return source.value;
    const value = this.values.get(source.secret_id);
    if (value === undefined)
      throw new Error("Validated browser secret was not resolved");
    return value;
  }

  url(destination: BrowserScenarioUrl): string {
    const url = new URL(destination.url);
    for (const { name, value } of destination.query)
      url.searchParams.append(name, this.value(value));
    return url.href;
  }

  redact(value: string): string {
    const literals = declaredLiterals(this.values, "raw");
    const output = replaceSecretLiterals(value, this.values, "raw", literals);
    return literals.some((literal) => output.includes(literal)) ? "" : output;
  }

  /** Redact serialized DOM/accessibility spellings without decoding the evidence. */
  redactArtifactText(value: string): string {
    const candidates = [...this.values]
      .flatMap(([id, secret]) => {
        if (secret === "") return [];
        // Share the raw marker policy without matching newly inserted markers.
        const marker = this.redact(secret);
        return artifactSecretPatterns(secret).map((pattern) => {
          const expression = new RegExp(pattern, "g");
          return { id, marker, expression, match: expression.exec(value) };
        });
      })
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    const parts: string[] = [];
    let offset = 0;
    while (true) {
      let next: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (candidate.match !== null && candidate.match.index < offset) {
          candidate.expression.lastIndex = offset;
          candidate.match = candidate.expression.exec(value);
        }
        const match = candidate.match;
        const previous = next?.match;
        if (
          match !== null &&
          (previous == null ||
            match.index < previous.index ||
            (match.index === previous.index &&
              match[0].length > previous[0].length))
        )
          next = candidate;
      }
      if (next?.match == null) break;
      parts.push(value.slice(offset, next.match.index), next.marker);
      offset = next.match.index + next.match[0].length;
    }
    if (parts.length === 0) return value;
    parts.push(value.slice(offset));
    const output = parts.join("");
    // A marker and its neighbors can reconstruct a declared spelling.
    return candidates.some(({ expression }) => {
      expression.lastIndex = 0;
      return expression.test(output);
    })
      ? ""
      : output;
  }

  /** Replace declared UTF-8, URI/form, and JSON-escaped secrets without decoding binary data. */
  redactBytes(value: Buffer): Buffer {
    const literals = declaredLiterals(this.values, "bytes");
    const candidates = secretNeedles(this.values, literals)
      .map((candidate) => ({
        ...candidate,
        index: value.indexOf(candidate.needle),
      }))
      .sort(
        (left, right) =>
          right.needle.length - left.needle.length ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    const parts: Buffer[] = [];
    let offset = 0;
    while (true) {
      let next: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (candidate.index >= 0 && candidate.index < offset)
          candidate.index = value.indexOf(candidate.needle, offset);
        if (
          candidate.index >= 0 &&
          (next === undefined || candidate.index < next.index)
        )
          next = candidate;
      }
      if (next === undefined) break;
      parts.push(value.subarray(offset, next.index), next.marker);
      offset = next.index + next.needle.length;
    }
    if (parts.length === 0) return value;
    parts.push(value.subarray(offset));
    const redacted = Buffer.concat(parts);
    return literals.some((literal) => redacted.includes(Buffer.from(literal)))
      ? Buffer.alloc(0)
      : redacted;
  }

  /** Remove only declared secret values from one URL and report that action. */
  sanitizeUrl(value: string): SanitizedBrowserUrl {
    const literals = declaredLiterals(this.values, "url");
    const output = replaceSecretLiterals(value, this.values, "url", literals);
    if (literals.some((literal) => output.includes(literal)))
      return {
        url: "",
        origin: null,
        query_parameter_names: [],
        redacted: true,
      };
    const sanitized = sanitizeBrowserUrl(output);
    return {
      ...sanitized,
      redacted: sanitized.redacted || output !== value,
    };
  }

  fingerprint(value: string): BrowserStorageValueFingerprint {
    for (const secret of this.values.values())
      if (secret !== "" && value.includes(secret))
        return { value_state: "redacted-secret", value_sha256: null };
    return {
      value_state: "hashed",
      value_sha256: createHash("sha256")
        .update(this.redact(value))
        .digest("hex"),
    };
  }
}
