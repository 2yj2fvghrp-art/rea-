/**
 * With the length check, the same language as quartets plus one padded final
 * quartet, without a repeated group, so multi-MiB input cannot exhaust the
 * regex backtracking stack.
 */
const BASE64 = /^[A-Za-z\d+/]*={0,2}$/u;

/**
 * Bytes of padded standard-alphabet base64, or undefined for other text.
 * Unused trailing bits are not checked; callers that require canonical text
 * compare it with the bytes' re-encoding.
 */
export const decodeBase64 = (value: string): Buffer | undefined =>
  value.length % 4 === 0 && BASE64.test(value)
    ? Buffer.from(value, "base64")
    : undefined;
