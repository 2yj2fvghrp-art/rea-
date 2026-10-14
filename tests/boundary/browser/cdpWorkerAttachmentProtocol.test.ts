import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

/** Inspect the page while answering `Target.getTargets` with `inventory`. */
const inspectWithWorkerInventory = async (
  inventory: (origin: string) => Readonly<Record<string, unknown>>,
) => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command, origin) =>
      command.method === "Target.getTargets" ? inventory(origin) : undefined,
  });
  try {
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
  } finally {
    await browser.close();
  }
};

it.each(["omitted", "null"] as const)(
  "excludes TargetInfo workers with %s required attached state",
  async (attachmentState) => {
    const value = await inspectWithWorkerInventory((origin) => ({
      targetInfos: [
        {
          targetId: "worker-1",
          type: "service_worker",
          url: `${origin}/worker.js`,
          openerId: "allowed-page",
          ...(attachmentState === "null" ? { attached: null } : {}),
        },
      ],
    }));
    expect(value.workers).toEqual([]);
    expect(value.completeness.excluded).toContainEqual({
      section: "workers",
      reason: "invalid_protocol_value",
      count: 1,
    });
  },
);

it("reports a worker inventory without a target list as unavailable", async () => {
  const value = await inspectWithWorkerInventory(() => ({ unrelated: true }));
  expect(value.workers).toEqual([]);
  expect(value.completeness.unavailable_sections).toContain("workers");
});

it("reports a worker inventory that is not a list as unavailable", async () => {
  // `unavailable(section)` records this exclusion, so the entry below is the
  // observable that a non-list inventory is not decoded item by item.
  const value = await inspectWithWorkerInventory(() => ({
    targetInfos: "worker-one",
  }));
  expect(value.workers).toEqual([]);
  expect(value.completeness.excluded).toContainEqual({
    section: "workers",
    reason: "provider_unavailable",
    count: null,
  });
});

it("reports a malformed worker inventory entry as an exclusion", async () => {
  const value = await inspectWithWorkerInventory(() => ({
    targetInfos: [null],
  }));
  expect(value.workers).toEqual([]);
  expect(value.completeness.excluded).toContainEqual({
    section: "workers",
    reason: "invalid_protocol_value",
    count: 1,
  });
});

it("keeps a delivered empty worker inventory a valid empty result", async () => {
  const value = await inspectWithWorkerInventory(() => ({ targetInfos: [] }));
  expect(value.workers).toEqual([]);
  expect(value.completeness.unavailable_sections).not.toContain("workers");
  expect(value.completeness.excluded).not.toContainEqual(
    expect.objectContaining({ section: "workers" }),
  );
});
