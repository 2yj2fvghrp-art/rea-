import { constants } from "node:buffer";

/** Callbacks for one newline-delimited provider response stream. */
export interface ProviderResponseLinesOptions {
  /** Receives each trimmed, non-empty line; return false to drop the rest of the chunk. */
  readonly onLine: (line: string) => boolean;
  /** Reports a line that cannot be assembled; its buffered prefix is already dropped. */
  readonly onOverflow: () => void;
  /** Longest line in UTF-16 code units; defaults to the runtime string limit. */
  readonly maxLineLength?: number;
}

/**
 * Splits decoded provider socket text into response lines.
 *
 * Provider replies are complete by contract, so the only line limit is the
 * runtime's maximum string length. Assembling a longer line would throw from
 * the socket listener and terminate the process instead of one session.
 */
export class ProviderResponseLines {
  readonly #options: ProviderResponseLinesOptions;
  readonly #maxLineLength: number;
  #fragments: string[] = [];
  #pendingLength = 0;

  constructor(options: ProviderResponseLinesOptions) {
    this.#options = options;
    this.#maxLineLength = options.maxLineLength ?? constants.MAX_STRING_LENGTH;
  }

  /** Consume one decoded socket chunk. */
  push(chunk: string): void {
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline >= 0) {
      if (!this.#append(chunk.slice(start, newline))) return;
      const line = this.#fragments.join("").trim();
      this.reset();
      if (line.length > 0 && !this.#options.onLine(line)) return;
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    this.#append(start === 0 ? chunk : chunk.slice(start));
  }

  /** Drop any incomplete line when a session closes. */
  reset(): void {
    this.#fragments = [];
    this.#pendingLength = 0;
  }

  #append(text: string): boolean {
    if (text.length === 0) return true;
    const length = this.#pendingLength + text.length;
    if (length > this.#maxLineLength) {
      this.reset();
      this.#options.onOverflow();
      return false;
    }
    this.#fragments.push(text);
    this.#pendingLength = length;
    return true;
  }
}
