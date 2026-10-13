import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { IosSimulatorCaptureService } from "../../../src/application/ios/IosSimulatorCaptureService.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { iosSimulatorCaptureResultSchema } from "../../../src/domain/ios/iosSimulatorCapture.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { SimctlSimulatorCapture } from "../../../src/ios/SimctlSimulatorCapture.js";
import { IOS_SIMULATOR_PROVIDER_IDENTITY } from "../../../src/ios/providerIdentity.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { createServer } from "../../../src/server/createServer.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9a4V8AAAAASUVORK5CYII=",
  "base64",
);
const simulator = {
  udid: UDID,
  name: "REA fixture iPhone",
  state: "Booted",
  isAvailable: true,
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
};
const inventory = (devices: readonly (typeof simulator)[] = [simulator]) =>
  JSON.stringify({
    devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-0": devices },
  });
const snapshot = (stdout = "", stderr = "") => ({
  stdout: {
    text: stdout,
    bytes: Buffer.byteLength(stdout),
    observedBytes: Buffer.byteLength(stdout),
  },
  stderr: {
    text: stderr,
    bytes: Buffer.byteLength(stderr),
    observedBytes: Buffer.byteLength(stderr),
  },
  exitCode: 0,
  signal: null,
});

it("rejects malformed selection and cancellation before acquiring a provider", async () => {
  let calls = 0;
  const provider = new SimctlSimulatorCapture({
    platform: "darwin",
    runCommand: async () => {
      calls++;
      return snapshot();
    },
  });
  const service = new IosSimulatorCaptureService(provider);
  const malformed = await service.execute({ simulator_udid: "booted" });
  expect(malformed.ok).toBe(false);
  if (!malformed.ok)
    expect(projectAnalysisError(malformed.error).code).toBe("invalid_request");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await service.execute(
    { simulator_udid: UDID },
    { signal: controller.signal },
  );
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok)
    expect(projectAnalysisError(cancelled.error).code).toBe("cancelled");
  expect(calls).toBe(0);
});

it("distinguishes absent and shutdown iOS simulators", async () => {
  const absent = new SimctlSimulatorCapture({
    platform: "darwin",
    runCommand: async () => snapshot(inventory([])),
  });
  const missing = await absent.capture({ simulator_udid: UDID });
  expect(missing.ok).toBe(false);
  if (!missing.ok)
    expect(projectAnalysisError(missing.error).code).toBe("unsupported_target");
  const shutdown = new SimctlSimulatorCapture({
    platform: "darwin",
    runCommand: async () =>
      snapshot(inventory([{ ...simulator, state: "Shutdown" }])),
  });
  const stopped = await shutdown.capture({ simulator_udid: UDID });
  expect(stopped.ok).toBe(false);
  if (!stopped.ok) {
    const projected = projectAnalysisError(stopped.error);
    expect(projected.code).toBe("capability_unavailable");
    expect(projected.details?.reason).toContain(UDID);
  }
});

it("enforces the complete PNG budget and removes the private screenshot", async () => {
  let rootPath = "";
  const provider = new SimctlSimulatorCapture({
    platform: "darwin",
    createRuntime: async (options) => {
      const root = await PrivateRuntimeRoot.create(options);
      rootPath = root.path;
      return root;
    },
    runCommand: async (spawn) => {
      if (spawn.arguments[1] === "list") return snapshot(inventory());
      await writeFile(
        spawn.arguments.at(-1) ?? "",
        Buffer.alloc(3 * 1024 * 1024 + 1),
      );
      return snapshot();
    },
  });
  const result = await provider.capture({ simulator_udid: UDID });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("resource_constraint");
    expect(projected.details?.reported_limits).toMatchObject({
      max_screenshot_bytes: 3 * 1024 * 1024,
    });
  }
  await expect(access(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports a missing screenshot as provider output, not a missing Xcode command", async () => {
  const provider = new SimctlSimulatorCapture({
    platform: "darwin",
    runCommand: async (spawn) =>
      spawn.arguments[1] === "list" ? snapshot(inventory()) : snapshot(),
  });
  const result = await provider.capture({ simulator_udid: UDID });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("unreadable_output");
    expect(projected.details?.reason).toContain("without producing a PNG");
  }
});

it("preserves simctl output when capture and cleanup both fail", async () => {
  const provider = new SimctlSimulatorCapture({
    platform: "darwin",
    createRuntime: async () => ({
      path: "/tmp/rea-test-cleanup-resource",
      close: async () => {
        throw new Error("cleanup blocked");
      },
    }),
    runCommand: async (spawn) => {
      if (spawn.arguments[1] === "list") return snapshot(inventory());
      throw new OwnedCommandFailure(
        "process",
        "simctl capture failed",
        snapshot("", "specific simulator denial"),
      );
    },
  });
  const result = await provider.capture({ simulator_udid: UDID });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("cleanup_incomplete");
    expect(projected.details?.captured_output).toMatchObject({
      stderr: "specific simulator denial",
    });
    expect(projected.details?.diagnostics).toMatchObject({
      execution_failure: expect.stringContaining("adapter failed"),
    });
    expect(projected.details?.resources).toContain(
      "/tmp/rea-test-cleanup-resource",
    );
  }
});

it("returns complete named MCP Evidence and matching CLI service semantics", async () => {
  const capture = iosSimulatorCaptureResultSchema.parse({
    simulator: {
      udid: UDID,
      name: simulator.name,
      runtime_id: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      device_type_id: simulator.deviceTypeIdentifier,
      state: "Booted",
    },
    screenshot: {
      mime_type: "image/png",
      base64: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      byte_length: PNG.length,
      width: 1,
      height: 1,
    },
    foreground_application: null,
    captured_at: "2026-10-13T00:00:00.000Z",
    limitations: ["Foreground app unknown."],
  });
  const provider = {
    identity: () => IOS_SIMULATOR_PROVIDER_IDENTITY,
    capture: async () => ok(capture),
  };
  const service = new IosSimulatorCaptureService(provider);
  const direct = await service.execute({ simulator_udid: UDID });
  expect(direct.ok).toBe(true);
  if (!direct.ok) return;
  const server = createServer(
    {
      kind: "fixed",
      analysis: { execute: () => Promise.resolve(observed(null)) },
    },
    {
      iosSimulatorCapture: provider,
    },
  );
  const client = new Client({ name: "ios-simulator-boundary", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const called = await client.callTool({
      name: "capture_ios_simulator_screen",
      arguments: { simulator_udid: UDID },
    });
    if (called.isError === true)
      throw new Error(`MCP capture failed: ${JSON.stringify(called.content)}`);
    const structured = parseEvidence(called.structuredContent);
    expect(
      iosSimulatorCaptureResultSchema.parse(structured.normalized_result),
    ).toEqual(capture);
    expect(structured).toEqual(direct.value);
    expect(JSON.stringify(called.content)).not.toContain(
      capture.screenshot.base64,
    );
    const summary = called.content[0];
    if (summary?.type !== "text") throw new Error("Missing capture summary");
    expect(JSON.parse(summary.text)).toMatchObject({
      complete_png: "structuredContent.normalized_result.screenshot.base64",
      result: { screenshot: { sha256: capture.screenshot.sha256 } },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
