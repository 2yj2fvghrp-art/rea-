const BINARY_PLIST_MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30];
const NIB_ARCHIVE_MAGIC = [
  0x4e, 0x49, 0x42, 0x41, 0x72, 0x63, 0x68, 0x69, 0x76, 0x65,
];

/** Recognize the exact binary plist version supported by the decoder, without validating its body. */
export const hasBinaryPlistSignature = (bytes: Uint8Array): boolean =>
  BINARY_PLIST_MAGIC.every((byte, index) => bytes[index] === byte);

/** Recognize an XML plist prolog without claiming that its document is valid. */
export const hasXmlPlistSignature = (bytes: Uint8Array): boolean => {
  const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  const decoder = new TextDecoder(encoding, { fatal: true });
  const scanProlog = createXmlPlistPrologScanner();
  // Decode only through each markup terminator so malformed bytes after an
  // already observed plist prolog cannot erase that earlier signature.
  const chunkSize = utf16le || utf16be ? 2 : 1;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    let end = Math.min(offset + chunkSize, bytes.length);
    if ((utf16le || utf16be) && end < bytes.length) end &= ~1;
    try {
      if (
        scanProlog(
          decoder.decode(bytes.subarray(offset, end), { stream: true }),
        )
      )
        return true;
    } catch {
      return false;
    }
  }
  try {
    return scanProlog(decoder.decode());
  } catch {
    return false;
  }
};

const createXmlPlistPrologScanner = (): ((chunk: string) => boolean) => {
  let text = "";
  let cursor = 0;
  let allowXmlDeclaration = true;
  let expectingDoctypeName = false;
  let doctypeWhitespaceSeen = false;
  let pending:
    | { readonly terminator: "?>" | "-->"; searchFrom: number }
    | undefined;

  return (chunk) => {
    text += chunk;
    while (true) {
      if (pending !== undefined) {
        const end = text.indexOf(pending.terminator, pending.searchFrom);
        if (end < 0) {
          pending.searchFrom = Math.max(
            pending.searchFrom,
            text.length - pending.terminator.length + 1,
          );
          return false;
        }
        cursor = end + pending.terminator.length;
        pending = undefined;
        continue;
      }

      if (cursor === 0 && text.startsWith("\uFEFF")) cursor = 1;
      if (expectingDoctypeName) {
        if (!doctypeWhitespaceSeen) {
          if (cursor === text.length) return false;
          if (!isXmlWhitespace(text[cursor]!)) return false;
          doctypeWhitespaceSeen = true;
        }
        while (cursor < text.length && isXmlWhitespace(text[cursor]!)) cursor++;
        if (cursor === text.length) return false;
        const name = tokenAt(text, cursor, "plist");
        if (name === "partial") return false;
        return name === "match" && isWordBoundary(text, cursor + 5);
      }
      while (cursor < text.length && isXmlWhitespace(text[cursor]!)) cursor++;
      if (cursor === text.length) return false;

      if (allowXmlDeclaration) {
        const declaration = tokenAt(text, cursor, "<?xml");
        if (declaration === "partial") return false;
        if (declaration === "match") {
          const whitespaceIndex = cursor + 5;
          if (whitespaceIndex === text.length) return false;
          if (!isXmlWhitespace(text[whitespaceIndex]!)) return false;
          allowXmlDeclaration = false;
          pending = { terminator: "?>", searchFrom: whitespaceIndex + 1 };
          continue;
        }
        allowXmlDeclaration = false;
      }

      const comment = tokenAt(text, cursor, "<!--");
      if (comment === "partial") return false;
      if (comment === "match") {
        pending = { terminator: "-->", searchFrom: cursor + 4 };
        continue;
      }

      const doctype = tokenAt(text, cursor, "<!DOCTYPE");
      if (doctype === "partial") return false;
      if (doctype === "match") {
        cursor += 9;
        expectingDoctypeName = true;
        continue;
      }

      const plist = tokenAt(text, cursor, "<plist");
      if (plist === "partial") return false;
      return plist === "match" && isWordBoundary(text, cursor + 6);
    }
  };
};

type TokenMatch = "match" | "partial" | "none";

const tokenAt = (text: string, offset: number, token: string): TokenMatch => {
  const available = text.slice(offset, offset + token.length);
  if (available === token) return "match";
  return token.startsWith(available) ? "partial" : "none";
};

const isXmlWhitespace = (character: string): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\r" ||
  character === "\n";

const isWordBoundary = (text: string, offset: number): boolean => {
  if (offset === text.length) return false;
  const character = text[offset]!;
  return !(
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    (character >= "0" && character <= "9") ||
    character === "_"
  );
};

/** Whether a bounded probe still looks like it may be entering an XML prolog. */
export const mayStartXmlPlistProlog = (bytes: Uint8Array): boolean => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return true;
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return /^\uFEFF?\s*(?:<\?xml\b|<!--|<!DOCTYPE\b|<plist\b|$)/u.test(prefix);
};

/** Recognize the serialized signature without claiming a valid NIB object table. */
export const hasNibArchiveSignature = (bytes: Uint8Array): boolean =>
  NIB_ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);
