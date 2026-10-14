import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string) =>
  analyzeJavaScriptStaticSource(source).endpoints.map(
    ({ kind, value, mechanism, resolution }) => ({
      kind,
      value,
      mechanism,
      ...(resolution === undefined ? {} : { resolution }),
    }),
  );

describe("partially resolved network endpoints", () => {
  it("retains an interpolated fetch template as a partial endpoint", () => {
    expect(
      endpoints("fetch(`https://core.example.com/notes/${id}/audio/`);"),
    ).toEqual([
      {
        kind: "network",
        value: "`https://core.example.com/notes/${id}/audio/`",
        mechanism: "call:fetch",
        resolution: "partial",
      },
    ]);
  });

  it("retains a variable-base template as a partial endpoint", () => {
    expect(
      endpoints(`
        const base = process.env.API_URL || "https://api.example.com";
        fetch(\`\${base}/internal/imports/\`);
      `),
    ).toEqual([
      {
        kind: "network",
        value: "`${base}/internal/imports/`",
        mechanism: "call:fetch",
        resolution: "partial",
      },
    ]);
  });

  it("resolves URL object bindings forwarded to WebSocket", () => {
    expect(
      endpoints(`
        const u = new URL("wss://realtime.example.com");
        const v = new URL("wss://voice.example.com");
        new WebSocket(u);
        new WebSocket(v.toString());
      `),
    ).toEqual([
      {
        kind: "network",
        value: "wss://realtime.example.com",
        mechanism: "call:WebSocket",
      },
      {
        kind: "network",
        value: "wss://voice.example.com",
        mechanism: "call:WebSocket",
      },
    ]);
  });

  it("resolves a constant config property forwarded to WebSocket", () => {
    expect(
      endpoints(`
        const cfg = { wsUrl: "wss://config.example.com" };
        new WebSocket(cfg.wsUrl);
      `),
    ).toEqual([
      {
        kind: "network",
        value: "wss://config.example.com",
        mechanism: "call:WebSocket",
      },
    ]);
  });

  it("retains a dynamic EventSource URL as a partial endpoint", () => {
    expect(endpoints("new EventSource(url);")).toEqual([
      {
        kind: "network",
        value: "url",
        mechanism: "call:EventSource",
        resolution: "partial",
      },
    ]);
  });

  it("does not report collection reads as partial endpoints", () => {
    expect(endpoints("map.get(key); config.delete(someSetting);")).toEqual([]);
  });
});
