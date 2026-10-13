import { describe, expect, it } from "vitest";

import { parseJebMcpEndpoint } from "./JebMcpEndpoint.js";

describe("JEB MCP endpoint", () => {
  it("rejects an explicit empty query or fragment instead of dropping it", () => {
    expect(parseJebMcpEndpoint("http://127.0.0.1:8425/mcp").ok).toBe(true);
    for (const value of [
      "http://127.0.0.1:8425/mcp?",
      "http://127.0.0.1:8425/mcp#",
      "http://127.0.0.1:8425/mcp?#",
    ])
      expect(parseJebMcpEndpoint(value).ok, value).toBe(false);
  });
});

it.each(["/mcp/extra", "/not-mcp"])(
  "rejects the unsupported JEB route %s",
  (path) => {
    const result = parseJebMcpEndpoint(`http://127.0.0.1:8425${path}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toContain("/mcp");
  },
);

it.each([
  undefined,
  "",
  "http://127.0.0.1:8425/mcp",
  "http://127.0.0.1:8425/mcp/",
  "https://127.0.0.1:9443/mcp",
  "http://[::1]:8425/mcp",
])("keeps the supported JEB endpoint unchanged: %s", (value) => {
  const result = parseJebMcpEndpoint(value);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.href).toBe(value || "http://127.0.0.1:8425/mcp");
});
