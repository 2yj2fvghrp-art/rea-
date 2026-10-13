import type { ProviderProcessSnapshot } from "./ProviderProcess.js";

type CapturedStream = Pick<
  ProviderProcessSnapshot["stdout"],
  "text" | "bytes" | "observedBytes"
>;

/** Redact explicit transport credentials from complete and budget-cut output. */
export const redactCapturedTransportCredential = (
  stream: CapturedStream,
  token: string | undefined,
  replacement: string,
): string =>
  redactCapturedTransportCredentials(
    stream,
    token === undefined ? [] : [token],
    replacement,
  );

/** Resolve the longest cut suffix against the original stream before any replacements. */
export const redactCapturedTransportCredentials = (
  stream: CapturedStream,
  tokens: Iterable<string>,
  replacement: string,
): string => {
  const credentials = [...tokens]
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length);
  const { text } = stream;
  let suffixLength = 0;
  if (stream.observedBytes > stream.bytes)
    for (const token of credentials)
      for (
        let length = Math.min(text.length, token.length);
        length > suffixLength;
        length--
      )
        if (text.endsWith(token.slice(0, length))) {
          suffixLength = length;
          break;
        }
  const matches: { start: number; end: number }[] = [];
  for (const token of credentials) {
    let offset = 0;
    while (offset <= text.length - token.length) {
      const start = text.indexOf(token, offset);
      if (start < 0) break;
      matches.push({ start, end: start + token.length });
      offset = start + 1;
    }
  }
  matches.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const merged: { start: number; end: number }[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous !== undefined && match.start <= previous.end)
      previous.end = Math.max(previous.end, match.end);
    else merged.push({ ...match });
  }

  let cutoff = suffixLength === 0 ? text.length : text.length - suffixLength;
  if (suffixLength > 0) {
    const crossing = merged.find(
      ({ start, end }) => start < cutoff && end > cutoff,
    );
    if (crossing !== undefined) cutoff = crossing.start;
  }
  let redactedPrefix = "";
  let cursor = 0;
  for (const match of merged) {
    if (match.start >= cutoff) break;
    redactedPrefix += text.slice(cursor, match.start) + replacement;
    cursor = Math.min(match.end, cutoff);
  }
  redactedPrefix += text.slice(cursor, cutoff);
  return suffixLength === 0 ? redactedPrefix : redactedPrefix + replacement;
};
