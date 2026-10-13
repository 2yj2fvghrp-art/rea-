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
  const usable =
    utf16le || utf16be ? bytes.subarray(0, bytes.length & ~1) : bytes;
  let text: string;
  try {
    text = new TextDecoder(
      utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8",
      { fatal: true },
    ).decode(usable, { stream: true });
  } catch {
    return false;
  }
  return /^\uFEFF?\s*(?:<\?xml\s[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+plist\b|<plist\b)/u.test(
    text,
  );
};

/** Recognize the serialized signature without claiming a valid NIB object table. */
export const hasNibArchiveSignature = (bytes: Uint8Array): boolean =>
  NIB_ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);
