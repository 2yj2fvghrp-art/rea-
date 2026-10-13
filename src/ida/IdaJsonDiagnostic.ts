import { createScanner, type ScanError, type SyntaxKind } from "jsonc-parser";

// jsonc-parser declares ambient const enums, which cannot be imported as values
// under verbatimModuleSyntax. Keep its scanner codes local and type-checked.
const JSON_STRING_LITERAL = 10 satisfies SyntaxKind;
const JSON_EOF = 17 satisfies SyntaxKind;
const JSON_NO_ERROR = 0 satisfies ScanError;

export const IDA_REDACTION_MARKER = "[redacted transport credential]";

type Match = Readonly<{ start: number; end: number }>;
/** Matches are non-overlapping and ordered by their UTF-16 source offsets. */
type Matches = (value: string) => readonly Match[];

// Complete JSON character runs remain meaningful even in an unfinished or
// malformed string. Invalid units separate runs instead of joining their text.
const JSON_CHARACTER_RUN =
  /(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\dA-Fa-f]{4}))+/gu;

const appendStringMatches = (
  encoded: string,
  decoded: string,
  offset: number,
  matches: Matches,
  ranges: Match[],
): void => {
  // Match offsets and JSON escape widths are both UTF-16 units. No source bytes
  // outside a matched value need to be normalized or serialized again.
  let sourceCursor = 0;
  let decodedCursor = 0;
  const sourceOffset = (boundary: number): number => {
    while (decodedCursor < boundary) {
      sourceCursor +=
        encoded[sourceCursor] === "\\"
          ? encoded[sourceCursor + 1] === "u"
            ? 6
            : 2
          : 1;
      decodedCursor++;
    }
    return offset + sourceCursor;
  };
  for (const match of matches(decoded))
    ranges.push({
      start: sourceOffset(match.start),
      end: sourceOffset(match.end),
    });
};

const appendCharacterRunMatches = (
  encoded: string,
  offset: number,
  matches: Matches,
  ranges: Match[],
): void => {
  for (const run of encoded.matchAll(JSON_CHARACTER_RUN)) {
    // The run grammar admits only complete JSON characters. JSON.parse owns
    // their decoded meaning; malformed units remain verbatim between runs.
    const decoded: unknown = JSON.parse('"' + run[0] + '"');
    if (typeof decoded !== "string")
      throw new TypeError("A JSON character run did not decode to a string.");
    const start = offset + run.index;
    appendStringMatches(run[0], decoded, start, matches, ranges);
  }
};

/** Redact complete or malformed JSON diagnostics without rewriting unrelated source. */
export const redactIdaJsonDiagnostic = (
  text: string,
  matches: Matches,
): string => {
  const ranges: Match[] = [];
  let validDocument = false;
  try {
    JSON.parse(text);
    validDocument = true;
  } catch {
    // Recovery cannot establish a unique meaning for a malformed document.
    // Retain both its raw credentials and complete decoded character matches.
  }
  const literalMatches = matches(text);
  let literalIndex = 0;
  const appendLiteralMatches = (end: number, completeString?: Match): void => {
    // Only a complete string in a valid document owns decoded-only semantics.
    // Raw matches crossing tokens remain visible to the credential boundary.
    while (literalIndex < literalMatches.length) {
      const match = literalMatches[literalIndex];
      if (match === undefined || match.start >= end) break;
      if (
        completeString === undefined ||
        match.start < completeString.start ||
        match.end > completeString.end
      )
        ranges.push(match);
      literalIndex++;
    }
  };
  let scannedEnd = 0;
  const scanner = createScanner(text);
  while (scanner.scan() !== JSON_EOF) {
    if (scanner.getToken() !== JSON_STRING_LITERAL) continue;
    const start = scanner.getTokenOffset();
    const end = start + scanner.getTokenLength();
    if (scannedEnd < start) {
      appendCharacterRunMatches(
        text.slice(scannedEnd, start),
        scannedEnd,
        matches,
        ranges,
      );
      appendLiteralMatches(start);
    }
    if (scanner.getTokenError() === JSON_NO_ERROR) {
      appendStringMatches(
        text.slice(start + 1, end - 1),
        scanner.getTokenValue(),
        start + 1,
        matches,
        ranges,
      );
      appendLiteralMatches(end, validDocument ? { start, end } : undefined);
    } else {
      appendCharacterRunMatches(
        text.slice(start + 1, end),
        start + 1,
        matches,
        ranges,
      );
      appendLiteralMatches(end);
    }
    scannedEnd = end;
  }
  appendCharacterRunMatches(
    text.slice(scannedEnd),
    scannedEnd,
    matches,
    ranges,
  );
  appendLiteralMatches(text.length);
  if (ranges.length === 0) return text;
  ranges.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  let pending: Match | undefined;
  for (const range of ranges) {
    if (pending !== undefined && range.start < pending.end) {
      pending = { start: pending.start, end: Math.max(pending.end, range.end) };
      continue;
    }
    if (pending !== undefined) {
      parts.push(text.slice(cursor, pending.start), IDA_REDACTION_MARKER);
      cursor = pending.end;
    }
    pending = range;
  }
  if (pending !== undefined) {
    parts.push(text.slice(cursor, pending.start), IDA_REDACTION_MARKER);
    cursor = pending.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};
