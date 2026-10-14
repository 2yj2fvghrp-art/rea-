import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import type { WebPageInspection } from "../../../src/domain/browserObservationSchemas.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

type ResourceMode =
  | "valid"
  | "missing"
  | "null"
  | "wrong-type"
  | "invalid-entry"
  | "child-missing"
  | "empty";

const startBrowser = async () => {
  const state = { mode: "valid" as ResourceMode };
  const browser = await startFakeCdpBrowser({
    commandResult(command, origin) {
      if (command.method !== "Page.getResourceTree") return undefined;
      const resource = (name: string) => ({
        url: origin + "/" + name,
        type: "Script",
        mimeType: "text/javascript",
        contentSize: 128,
      });
      let resources: unknown = [resource("keep.js"), resource("peer.js")];
      if (state.mode === "missing") resources = undefined;
      if (state.mode === "null") resources = null;
      if (state.mode === "wrong-type") resources = {};
      if (state.mode === "invalid-entry")
        resources = [resource("keep.js"), null];
      if (state.mode === "empty") resources = [];
      return {
        frameTree: {
          frame: { id: "frame-main", url: origin + "/app" },
          resources,
          ...(state.mode === "child-missing"
            ? {
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      parentId: "frame-main",
                      url: origin + "/child",
                    },
                  },
                ],
              }
            : {}),
        },
      };
    },
  });
  trackBrowser(browser);
  const inspect = async () => {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
  return { state, inspect, origin: browser.allowedOrigin };
};

const compareResources = (
  before: WebPageInspection,
  after: WebPageInspection,
) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions.resources;

describe("resource inventory omissions through CDP", () => {
  it.each([
    "missing",
    "null",
    "wrong-type",
    "invalid-entry",
    "child-missing",
  ] as const)(
    "does not claim a resource removal or equality for %s",
    async (mode) => {
      const { state, inspect, origin } = await startBrowser();
      const before = await inspect();
      expect(before.resources).toHaveLength(2);
      expect(before.completeness.unavailable_sections).not.toContain(
        "resources",
      );
      state.mode = mode;
      const after = await inspect();
      for (const [left, right] of [
        [before, after],
        [after, before],
        [after, after],
      ] as const)
        expect(compareResources(left, right)).toMatchObject({
          status: "unknown",
          total_changes: 0,
          changes: [],
        });
      expect(after.completeness.unavailable_sections).toContain("resources");
      expect(after.completeness.excluded).toContainEqual({
        section: "resources",
        reason: "invalid_protocol_value",
        count: mode === "invalid-entry" ? 1 : null,
      });
      const expected =
        mode === "invalid-entry"
          ? [origin + "/keep.js"]
          : mode === "child-missing"
            ? [origin + "/keep.js", origin + "/peer.js"]
            : [];
      expect(after.resources.map(({ url }) => url).sort()).toEqual(expected);
    },
  );

  it("distinguishes a complete empty inventory from an unavailable collection", async () => {
    const { state, inspect } = await startBrowser();
    const before = await inspect();
    state.mode = "empty";
    const after = await inspect();
    expect(after.resources).toEqual([]);
    expect(after.completeness.unavailable_sections).not.toContain("resources");
    expect(compareResources(before, after)).toMatchObject({
      status: "changed",
      total_changes: 2,
      changes: [{ change: "removed" }, { change: "removed" }],
    });
    expect(compareResources(after, after).status).toBe("unchanged");
  });
});

describe("resource uncertainty in public CLI Evidence", () => {
  it("preserves partial membership while complete inventories still prove removal", async () => {
    const { state, inspect } = await startBrowser();
    const root = await createTestTempDirectory("rea-resource-comparison-");
    const before = join(root, "before.json");
    const after = join(root, "after.json");
    await writeFile(before, JSON.stringify({ inspection: await inspect() }));
    for (const mode of ["invalid-entry", "empty"] as const) {
      state.mode = mode;
      await writeFile(after, JSON.stringify({ inspection: await inspect() }));
      expect(
        await runCliJson(["compare-web-captures", before, after, "--json"]),
      ).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: {
          dimensions: {
            resources: {
              status: mode === "empty" ? "changed" : "unknown",
              total_changes: mode === "empty" ? 2 : 0,
            },
          },
        },
      });
    }
  });
});
