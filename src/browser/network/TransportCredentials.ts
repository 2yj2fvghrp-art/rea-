/** Headers carrying transport credentials, which browser network evidence never retains. */
export const TRANSPORT_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);
