import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const startBrowser = async (options: FakeOptions = {}) => {
  const browser = await startFakeCdpBrowser({
    ...options,
    commandResult(command, origin, frameReads) {
      if (command.method === "DOMSnapshot.captureSnapshot") {
        const nodes = {
          nodeType: [9, 1, 1, 1, 1],
          nodeName: [1, 2, 3, 3, 3],
          nodeValue: [4, 4, 4, 4, 4],
          parentIndex: [-1, 0, 1, 1, 1],
          backendNodeId: [1, 2, 3, 4, 5],
          attributes: [[], [], [5, 6], [5, 7], [5, 6, 8, 9]],
        };
        return {
          strings: [
            `${origin}/app`,
            "#document",
            "HTML",
            "a",
            "",
            "xlink:href",
            "/first",
            "/second",
            "href",
            "/ordinary",
            "https://excluded.example/page",
          ],
          documents: [
            { documentURL: 0, nodes },
            {
              documentURL: 10,
              nodes: { ...nodes, backendNodeId: [11, 12, 13, 14, 15] },
            },
          ],
        };
      }
      const override = options.commandResult?.(command, origin, frameReads);
      if (override !== undefined) return override;
      if (command.method === "DOM.describeNode")
        return {
          node: {
            backendNodeId: command.params.backendNodeId,
            nodeType: 1,
            nodeName: "a",
            isSVG: true,
          },
        };
      return undefined;
    },
  });
  trackBrowser(browser);
  return browser;
};

const inspect = (browser: FakeCdpBrowser, signal?: AbortSignal) =>
  new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 0,
    }),
    signal === undefined ? undefined : { signal },
  );

describe("CDP SVG identity at the snapshot boundary", () => {
  it("describes only in-scope XLink candidates without a winning href", async () => {
    const browser = await startBrowser();
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(result.value.metadata.dom_urls.map(({ url }) => url)).toEqual(
      ["/first", "/second", "/ordinary"].map(
        (path) => browser.allowedOrigin + path,
      ),
    );
    expect(
      browser.commands
        .filter(({ method }) => method === "DOM.describeNode")
        .map(({ params }) => params),
    ).toEqual([
      { backendNodeId: 3, depth: 0 },
      { backendNodeId: 4, depth: 0 },
    ]);
  });

  it.each(["removed", "mismatched"])(
    "retains partial metadata when a candidate is %s",
    async (failure) => {
      const browser = await startBrowser({
        commandError: (command) =>
          failure === "removed" &&
          command.method === "DOM.describeNode" &&
          command.params.backendNodeId === 3
            ? { code: -32_000, message: "No node found for given backend id" }
            : undefined,
        commandResult: (command) =>
          failure === "mismatched" &&
          command.method === "DOM.describeNode" &&
          command.params.backendNodeId === 3
            ? {
                node: {
                  backendNodeId: 99,
                  nodeType: 1,
                  nodeName: "a",
                  isSVG: true,
                },
              }
            : undefined,
      });
      const result = await inspect(browser);
      if (!result.ok) throw result.error;
      expect(result.value.metadata.dom_urls.map(({ url }) => url)).toEqual(
        ["/second", "/ordinary"].map((path) => browser.allowedOrigin + path),
      );
      expect(result.value.completeness.excluded).toContainEqual({
        section: "metadata",
        reason: "provider_unavailable",
        count: 1,
      });
      expect(result.value.limitations).toContain(
        "SVG identity was unavailable for 1 snapshotted XLink candidate nodes; their URL destinations remain unknown.",
      );
    },
  );

  it("records all unknown candidates after one unsupported-method reply", async () => {
    const browser = await startBrowser({
      unsupportedMethods: ["DOM.describeNode"],
    });
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(result.value.metadata.dom_urls.map(({ url }) => url)).toEqual([
      `${browser.allowedOrigin}/ordinary`,
    ]);
    expect(result.value.completeness.excluded).toContainEqual({
      section: "metadata",
      reason: "provider_unavailable",
      count: 2,
    });
    expect(
      browser.commands.filter(({ method }) => method === "DOM.describeNode"),
    ).toHaveLength(1);
  });

  it.each([
    { options: { closeOnMethod: "DOM.describeNode" }, reason: "disconnected" },
    {
      options: {
        commandError: (command: { method: string }) =>
          command.method === "DOM.describeNode"
            ? { code: -32_602, message: "Invalid parameters" }
            : undefined,
      },
      reason: "protocol_error",
    },
  ])(
    "propagates $reason during node description",
    async ({ options, reason }) => {
      const browser = await startBrowser(options);
      expect(await inspect(browser)).toMatchObject({
        ok: false,
        error: { _tag: "BrowserObservationError", reason },
      });
    },
  );

  it("cancels a pending description and detaches without closing the target", async () => {
    const browser = await startBrowser({ hangOnMethod: "DOM.describeNode" });
    const controller = new AbortController();
    const pending = inspect(browser, controller.signal);
    await expect
      .poll(() =>
        browser.commands.some(({ method }) => method === "DOM.describeNode"),
      )
      .toBe(true);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "inspect_web_page" },
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
  });
});
