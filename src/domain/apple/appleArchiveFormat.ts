const BINARY_PLIST_MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30];
const NIB_ARCHIVE_MAGIC = [
  0x4e, 0x49, 0x42, 0x41, 0x72, 0x63, 0x68, 0x69, 0x76, 0x65,
];

/** Recognize the exact binary plist version supported by the decoder, without validating its body. */
export const hasBinaryPlistSignature = (bytes: Uint8Array): boolean =>
  BINARY_PLIST_MAGIC.every((byte, index) => bytes[index] === byte);

/** Recognize the serialized signature without claiming a valid NIB object table. */
export const hasNibArchiveSignature = (bytes: Uint8Array): boolean =>
  NIB_ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);

/** Bytes inspected when recognizing an XML property list by content. */
export const XML_PLIST_SIGNATURE_PREFIX_BYTES = 1024;

const decodeXmlPlistPrefix = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const start =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8").decode(bytes.subarray(start));
};

/**
 * Recognize an XML property list from its leading bytes, without validating its body.
 * Accepts an optional BOM, leading whitespace, an XML declaration and comments
 * before a `plist` doctype or root element.
 */
export const hasXmlPlistSignature = (bytes: Uint8Array): boolean => {
  let text = decodeXmlPlistPrefix(
    bytes.subarray(0, XML_PLIST_SIGNATURE_PREFIX_BYTES),
  ).trimStart();
  const declaration = /^<\?xml\s[^?]*\?>/u.exec(text);
  if (declaration !== null) text = text.slice(declaration[0].length);
  for (;;) {
    text = text.trimStart();
    if (!text.startsWith("<!--")) break;
    const end = text.indexOf("-->");
    if (end === -1) return false;
    text = text.slice(end + 3);
  }
  return /^<!DOCTYPE\s+plist(?:\s|\[|>)/u.test(text) || /^<plist[\s>]/u.test(text);
};
