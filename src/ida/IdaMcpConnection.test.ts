import { describe, expect, it } from "vitest";
import {
  decodeIdaToolResult,
  createIdaDiagnosticRedactor,
} from "./IdaMcpConnection.js";

describe("IDA diagnostic credential redaction", () => {
  it.each([false, true])(
    "redacts literal credentials once regardless of header order (reversed: %s)",
    (reversed) => {
      const entries = [
        ["Authorization", "Bearer fixture"],
        ["proxy-AUTHORIZATION", "bAsIc fixture-long.$[token]"],
        ["cOoKiE", "session=fixture-long.$[token]; marker=redacted"],
        ["X-Evidence", "caller-selected-evidence"],
      ];
      const redact = createIdaDiagnosticRedactor({
        url: "http://127.0.0.1:12345/mcp",
        headers: Object.fromEntries(reversed ? entries.reverse() : entries),
        mode: "attached",
        timeoutMs: 1000,
      });
      expect(
        redact(
          "Bearer fixture / fixture / bAsIc fixture-long.$[token] / fixture-long.$[token] / session=fixture-long.$[token]; marker=redacted /caller/input?token=visible API_KEY=visible caller-selected-evidence",
        ),
      ).toBe(
        "[redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] /caller/input?token=visible API_KEY=visible caller-selected-evidence",
      );
    },
  );
  it("redacts configured and HTTP-normalized header values", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: {
        aUtHoRiZaTiOn: "\r\n \tBearer fixture-secret \t\r\n",
        "pRoXy-AuThOrIzAtIoN": "\tBasic proxy-secret ",
        CoOkIe: " session=cookie-secret\t",
      },
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(
      redact(
        "raw=\r\n \tBearer fixture-secret \t\r\n; wire=Bearer fixture-secret; token=fixture-secret; proxy=Basic proxy-secret; bare=proxy-secret; cookie=session=cookie-secret",
      ),
    ).toBe(
      "raw=[redacted transport credential]; wire=[redacted transport credential]; token=[redacted transport credential]; proxy=[redacted transport credential]; bare=[redacted transport credential]; cookie=[redacted transport credential]",
    );
  });
  it("does not treat empty HTTP authentication as diagnostic content", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: {
        Authorization: "\r\n \t \r\n",
        "Proxy-Authorization": "",
        Cookie: "\t",
      },
      mode: "attached",
      timeoutMs: 1000,
    });
    const message = "Failed at /caller/input \t with ordinary whitespace";
    expect(redact(message)).toBe(message);
  });
  it("does not reprocess the replacement marker as another credential", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer alpha", Cookie: "redacted" },
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(redact("alpha redacted")).toBe(
      "[redacted transport credential] [redacted transport credential]",
    );
  });
});

describe("upstream IDA tool result decoding", () => {
  it("leaves successful legacy, structured, and native evidence unchanged", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    const evidence = "Caller-selected fixture-secret evidence";
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: evidence }] },
        undefined,
        redact,
      ),
    ).toBe(evidence);
    expect(
      decodeIdaToolResult(
        { content: [], structuredContent: { evidence } },
        undefined,
        redact,
      ),
    ).toEqual({ evidence });
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: JSON.stringify({ evidence }) }] },
        "native",
        redact,
      ),
    ).toEqual({ evidence });
  });
  it("redacts credentials in truncated-output diagnostics before constructing the error", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(() =>
      decodeIdaToolResult(
        {
          content: [],
          _meta: {
            ida_mcp: {
              output_truncated: true,
              download_hint:
                "Download /caller/output?cursor=kept using Bearer fixture-secret",
            },
          },
        },
        undefined,
        redact,
      ),
    ).toThrow(
      "Download /caller/output?cursor=kept using [redacted transport credential]",
    );
  });
  it("decodes scalar wrappers and legacy text without dropping structured dictionaries", () => {
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: "code" },
      }),
    ).toBe("code");
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { path: "input", result: "field" },
      }),
    ).toEqual({ path: "input", result: "field" });
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: '[{"address":"0x1000"}]' }],
      }),
    ).toEqual([{ address: "0x1000" }]);
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: "int main(void);" }],
      }),
    ).toBe("int main(void);");
  });
  it("preserves upstream failures and rejects truncated previews that still satisfy item schemas", () => {
    expect(() => decodeIdaToolResult({ content: [] })).toThrow(
      "empty observation",
    );
    expect(() =>
      decodeIdaToolResult({
        isError: true,
        content: [{ type: "text", text: "Decompiler license is unavailable" }],
      }),
    ).toThrow("Decompiler license is unavailable");
    expect(() =>
      decodeIdaToolResult({
        isError: false,
        structuredContent: {
          result: [{ addr: "0x1000", name: "main", size: "0x20" }],
        },
        content: [{ type: "text", text: "preview" }],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            total_chars: 70000,
            download_hint: "Download the full upstream output",
          },
        },
      }),
    ).toThrow("Download the full upstream output");
  });
});
