import { createHash } from "node:crypto";

import { REDACTED_URL_HOST } from "../domain/browserSession.js";
import { decodeBase64 } from "./network/Base64.js";

/**
 * Multi-literal search (Aho-Corasick over UTF-16 code units). Built once, it
 * scans text in time linear in its length however many literals are declared,
 * visiting only the longest literal that ends at each position.
 */
class LiteralMatcher {
  readonly #next: Map<number, number>[] = [new Map()];
  readonly #fail: number[] = [0];
  readonly #length: number[] = [0];
  readonly #pattern: number[] = [-1];
  readonly #dictionary: number[] = [0];

  constructor(patterns: readonly string[]) {
    patterns.forEach((pattern, index) => this.#insert(pattern, index));
    const queue = [...this.#children(0).values()];
    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head] ?? 0;
      for (const [code, child] of this.#children(state)) {
        queue.push(child);
        let fallback = this.#fail[state] ?? 0;
        while (fallback !== 0 && !this.#children(fallback).has(code))
          fallback = this.#fail[fallback] ?? 0;
        const target = this.#children(fallback).get(code);
        const fail = target !== undefined && target !== child ? target : 0;
        this.#fail[child] = fail;
        this.#dictionary[child] =
          (this.#pattern[fail] ?? -1) >= 0
            ? fail
            : (this.#dictionary[fail] ?? 0);
      }
    }
  }

  /** True when any literal occurs in the text. */
  has(text: string): boolean {
    let found = false;
    this.#scan(text, () => {
      found = true;
      return false;
    });
    return found;
  }

  /**
   * [start, end, pattern] runs covering every literal occurrence: overlapping
   * occurrences merge into one run named by its leftmost literal, so no part
   * of any occurrence stays outside a run.
   */
  matches(text: string): Array<readonly [number, number, number]> {
    const found: Array<readonly [number, number, number]> = [];
    this.#scan(text, (end, length, pattern) => {
      if (pattern >= 0) found.push([end - length, end, pattern]);
      return true;
    });
    found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const runs: Array<[number, number, number]> = [];
    for (const [start, end, pattern] of found) {
      const last = runs.at(-1);
      if (last !== undefined && start < last[1])
        last[1] = Math.max(last[1], end);
      else runs.push([start, end, pattern]);
    }
    return runs;
  }

  #scan(
    text: string,
    visit: (end: number, length: number, pattern: number) => boolean,
  ): void {
    let state = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      while (state !== 0 && !this.#children(state).has(code))
        state = this.#fail[state] ?? 0;
      state = this.#children(state).get(code) ?? 0;
      // Shorter literals ending here lie inside the longest one.
      const hit =
        (this.#pattern[state] ?? -1) >= 0
          ? state
          : (this.#dictionary[state] ?? 0);
      if (
        hit !== 0 &&
        !visit(index + 1, this.#length[hit] ?? 0, this.#pattern[hit] ?? -1)
      )
        return;
    }
  }

  #insert(pattern: string, index: number): void {
    if (pattern === "") return;
    let state = 0;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      const code = pattern.charCodeAt(offset);
      let child = this.#children(state).get(code);
      if (child === undefined) {
        child = this.#next.length;
        this.#next.push(new Map());
        this.#fail.push(0);
        this.#length.push(0);
        this.#pattern.push(-1);
        this.#dictionary.push(0);
        this.#children(state).set(code, child);
      }
      state = child;
    }
    if ((this.#pattern[state] ?? -1) < 0) {
      this.#pattern[state] = index;
      this.#length[state] = pattern.length;
    }
  }

  #children(state: number): Map<number, number> {
    const children = this.#next[state];
    if (children === undefined)
      throw new Error("Literal matcher state is missing");
    return children;
  }
}

/** Replaced pieces joined at a time, so a field's matches never all live at once. */
const JOINED_PIECES = 4_096;

/**
 * The value with each match of a global pattern replaced, or the value itself
 * when nothing matches. String#replace gathers every match before replacing
 * any, and a 32 MiB field can hold millions of them.
 */
const replaceMatches = (
  value: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
): string => {
  const joined: string[] = [];
  let pieces: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    pieces.push(value.slice(offset, match.index), replace(match));
    offset = match.index + match[0].length;
    if (pieces.length >= JOINED_PIECES) {
      joined.push(pieces.join(""));
      pieces = [];
    }
  }
  if (joined.length === 0 && pieces.length === 0) return value;
  joined.push(pieces.join(""), value.slice(offset));
  return joined.join("");
};

/** Decode every %XX run byte-wise; invalid UTF-8 becomes U+FFFD, as in URLSearchParams. */
const percentDecoded = (value: string): string =>
  value.includes("%")
    ? replaceMatches(value, /(?:%[0-9a-f]{2})+/giu, ([run]) =>
        Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"),
      )
    : value;

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Undo JSON string escapes, including non-canonical ones such as \/ and é. */
const jsonUnescaped = (value: string): string =>
  value.includes("\\")
    ? replaceMatches(
        value,
        /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/gu,
        ([, hex, escape]) =>
          hex === undefined
            ? (JSON_ESCAPES[escape ?? ""] ?? "")
            : String.fromCharCode(Number.parseInt(hex, 16)),
      )
    : value;

/** Nested encodings a consumer might undo, bounded to a few levels. */
const DECODING_DEPTH = 3;

/** Percent, form and JSON decoding; each returns text it cannot change as is. */
const DECODERS: ReadonlyArray<(text: string) => string> = [
  percentDecoded,
  // Without a '+', a form reads text exactly as percent decoding does.
  (text) =>
    text.includes("+") ? percentDecoded(text.replaceAll("+", " ")) : text,
  jsonUnescaped,
];

/** Names a text by its exact UTF-16 code units without keeping it. */
const digest = (text: string): string =>
  createHash("sha256").update(text, "utf16le").digest("base64");

/**
 * The value, then each distinct nested decoding as it is produced. Fields
 * reach 32 MiB, so the search is depth-first: at most one decoding per level
 * is alive, and a consumer that stops at a match builds none of the rest.
 */
const decodings = function* (value: string): Generator<string> {
  yield value;
  // Fewest steps that reached each decoding: one reached again in fewer steps
  // is expanded again, so every decoding within DECODING_DEPTH steps is seen.
  const steps = new Map<string, number>();
  function* expand(text: string, depth: number): Generator<string> {
    if (depth === DECODING_DEPTH) return;
    for (const decode of DECODERS) {
      const decoded = decode(text);
      if (decoded === text) continue;
      const key = digest(decoded);
      const reached = steps.get(key);
      if (reached !== undefined && reached <= depth + 1) continue;
      steps.set(key, depth + 1);
      if (reached === undefined) yield decoded;
      yield* expand(decoded, depth + 1);
    }
  }
  yield* expand(value, 0);
};

/** Lone surrogates, which have no UTF-8 spelling, read as U+FFFD as URL encoders write them. */
const wellFormed = (value: string): string =>
  Buffer.from(value, "utf8").toString("utf8");

/** Spellings a literal takes in URLs, forms and JSON text. */
const spellings = (literal: string): string[] => [
  ...new Set([
    literal,
    // A lone surrogate has no URL spelling: encodeURIComponent throws and a
    // form would spell U+FFFD, which is not the literal.
    ...(wellFormed(literal) === literal
      ? [
          encodeURIComponent(literal),
          new URLSearchParams([["v", literal]]).toString().slice("v=".length),
        ]
      : []),
    JSON.stringify(literal).slice(1, -1),
  ]),
];

/** A UTF-8 string's bytes as one latin1 char per byte. */
const asBytes = (text: string): string =>
  Buffer.from(text, "utf8").toString("latin1");

const URL_PARTS =
  /^([a-z][a-z\d+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/iu;

/**
 * Replace caller-declared literals in result strings and count the fields
 * that changed. Browsers and servers spell one value in many ways, so every
 * field is checked against its percent-, form- and JSON-decoded forms: a
 * literal that survives any of them fails the field closed. URLs are
 * redacted piece by piece so unrelated parts keep their exact bytes.
 */
export class SessionRedactor {
  fields = 0;
  readonly #detector: LiteralMatcher | undefined;
  readonly #replacer: LiteralMatcher | undefined;
  readonly #markers: readonly string[] = [];
  readonly #byteReplacer: LiteralMatcher | undefined;
  readonly #byteMarkers: readonly string[] = [];

  constructor(literals: readonly string[]) {
    const declared = [...new Set(literals)].filter((literal) => literal !== "");
    if (declared.length === 0) return;
    const forms = declared.map(spellings);
    const replacer = new LiteralMatcher(forms.flat());
    // A marker must spell no literal, raw or percent-encoded as in URL pieces.
    const markers = declared.map(
      (_, index) =>
        [`[REDACTED:value-${String(index + 1)}]`, "[REDACTED]", ""].find(
          (candidate) =>
            !replacer.has(candidate) &&
            !replacer.has(encodeURIComponent(candidate)),
        ) ?? "",
    );
    this.#markers = forms.flatMap((group, index) =>
      group.map(() => markers[index] ?? ""),
    );
    this.#detector = new LiteralMatcher(declared);
    this.#replacer = replacer;
    // Binary content is matched on bytes: one latin1 char per byte.
    this.#byteReplacer = new LiteralMatcher(forms.flat().map(asBytes));
    this.#byteMarkers = this.#markers.map(asBytes);
  }

  /** A URL keeps its exact bytes except the pieces that spell a literal. */
  url(value: string): string {
    if (!this.#leaks(value)) return value;
    const parts = URL_PARTS.exec(value);
    if (parts === null) return this.text(value);
    const [, scheme = "", authority = "", path = "", search = "", hash = ""] =
      parts;
    // The port is the ':' and digits ending the authority (an IPv6 host is
    // bracketed). A redacted host keeps a port that spells no literal; a port
    // that spells one keeps only its ':', which marks the removed digits.
    const port = /:\d*$/u.exec(authority)?.[0] ?? "";
    const host = authority.slice(0, authority.length - port.length);
    const redacted = [
      scheme,
      this.#leaks(authority)
        ? (this.#leaks(host) ? `//${REDACTED_URL_HOST}` : host) +
          (this.#leaks(port) ? ":" : port)
        : authority,
      path
        .split("/")
        .map((segment) => this.#piece(segment, false))
        .join("/"),
      search === ""
        ? ""
        : `?${search
            .slice(1)
            .split("&")
            .map((pair) => this.#pair(pair))
            .join("&")}`,
      hash === ""
        ? ""
        : `#${hash
            .slice(1)
            .split(/([&/=?])/u)
            .map((piece) =>
              /^[&/=?]$/u.test(piece) ? piece : this.#piece(piece, false),
            )
            .join("")}`,
    ].join("");
    // A literal spanning pieces (host into port or path, across & or =) fails
    // closed to the first placeholder URL that spells no literal, else to "".
    return this.#changed(
      value,
      [
        redacted,
        `${scheme}//${REDACTED_URL_HOST}/`,
        "urn:redacted",
        "x:y",
      ].find((candidate) => !this.#leaks(candidate)) ?? "",
    );
  }

  /** Free text; a literal that survives replacement empties the field. */
  text(value: string): string {
    if (!this.#leaks(value)) return value;
    const redacted = this.#replace(value);
    return this.#changed(value, this.#leaks(redacted) ? "" : redacted);
  }

  /**
   * Canonical base64 content, matched on its decoded bytes and on the base64
   * text itself, which spells a base64 literal whose bytes sit at an offset
   * divisible by three. Retention admits only canonical base64, and base64
   * text cannot be edited without changing other bytes, so anything else, or
   * a literal surviving in either form, fails closed.
   */
  base64(value: string): string {
    if (this.#detector === undefined) return value;
    const bytes = decodeBase64(value);
    if (bytes === undefined || bytes.toString("base64") !== value)
      return this.#changed(value, "");
    if (!this.#bytesLeak(bytes) && !this.#leaks(value)) return value;
    const redacted = Buffer.from(
      this.#replace(
        bytes.toString("latin1"),
        this.#byteReplacer,
        this.#byteMarkers,
      ),
      "latin1",
    );
    const encoded = redacted.toString("base64");
    return this.#changed(
      value,
      this.#bytesLeak(redacted) || this.#leaks(encoded) ? "" : encoded,
    );
  }

  #bytesLeak(bytes: Buffer): boolean {
    return this.#leaks(bytes.toString("utf8"));
  }

  /** True when a declared literal appears in any decoding of the value. */
  #leaks(value: string): boolean {
    const detector = this.#detector;
    if (detector === undefined) return false;
    for (const text of decodings(value)) if (detector.has(text)) return true;
    return false;
  }

  #pair(pair: string): string {
    if (!this.#leaks(pair)) return pair;
    const separator = pair.indexOf("=");
    if (separator >= 0)
      return `${this.#piece(pair.slice(0, separator), true)}=${this.#piece(pair.slice(separator + 1), true)}`;
    // An emptied flag stays a pair, so the query keeps its pair positions.
    const flag = this.#piece(pair, true);
    return flag === "" ? "=" : flag;
  }

  /** A leaking URL piece becomes its redacted decoded text, percent-encoded. */
  #piece(piece: string, form: boolean): string {
    if (!this.#leaks(piece)) return piece;
    // Spellings as written go first: decoding can erase the one that matched
    // (a form '+' read as a space, a lowercase or unreserved escape). Markers
    // hold no '+', '%' or '\', so decoding leaves them intact.
    const written = this.#replace(piece);
    // A lone-surrogate literal matched inside a pair leaves the other half unpaired.
    const redacted = wellFormed(
      this.#replace(
        percentDecoded(form ? written.replaceAll("+", " ") : written),
      ),
    );
    const encoded = encodeURIComponent(redacted);
    // A form reads a written '+' as a space, so a literal spelled with one
    // beside an escape reaches the decoded text with a space instead.
    return [
      encoded,
      redacted,
      ...(form ? [redacted.replaceAll(" ", "+")] : []),
    ].some((text) => this.#leaks(text))
      ? ""
      : encoded;
  }

  #replace(
    value: string,
    matcher = this.#replacer,
    markers = this.#markers,
  ): string {
    const matches = matcher?.matches(value) ?? [];
    if (matches.length === 0) return value;
    let output = "";
    let offset = 0;
    for (const [start, end, pattern] of matches) {
      output += value.slice(offset, start) + (markers[pattern] ?? "");
      offset = end;
    }
    return output + value.slice(offset);
  }

  #changed(before: string, after: string): string {
    if (after !== before) this.fields += 1;
    return after;
  }
}

/** Values of explicitly named query parameters observed in retained URLs. */
export const declaredQueryValues = (
  urls: Iterable<string>,
  names: readonly string[],
): string[] => {
  const wanted = new Set(names);
  const values = new Set<string>();
  if (wanted.size === 0) return [];
  for (const url of urls) {
    if (!URL.canParse(url)) continue;
    for (const [name, value] of new URL(url).searchParams)
      if (wanted.has(name) && value !== "") values.add(value);
  }
  return [...values];
};
