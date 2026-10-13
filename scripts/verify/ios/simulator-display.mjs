#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { iosSimulatorCaptureResultSchema } from "../../../dist/domain/ios/iosSimulatorCapture.js";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = join(repository, "scripts/fixtures/ios");
const entrypoint = join(repository, "scripts/rea.mjs");
const UUID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;

if (process.platform !== "darwin")
  throw new Error(
    "verify:ios-simulator requires macOS and Xcode CoreSimulator.",
  );
const sdk = (
  await command("/usr/bin/xcrun", [
    "--sdk",
    "iphonesimulator",
    "--show-sdk-path",
  ])
).stdout.trim();
const macSdk = (
  await command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"])
).stdout.trim();
const swiftc = (
  await command("/usr/bin/xcrun", ["--find", "swiftc"])
).stdout.trim();
const inventory = JSON.parse(
  (await command("/usr/bin/xcrun", ["simctl", "list", "devices", "--json"]))
    .stdout,
);
const choice = Object.entries(inventory.devices)
  .flatMap(([runtime, devices]) =>
    devices.map((device) => ({ runtime, device })),
  )
  .find(
    ({ runtime, device }) =>
      runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
      device.isAvailable === true &&
      device.name.startsWith("iPhone") &&
      typeof device.deviceTypeIdentifier === "string",
  );
if (choice === undefined)
  throw new Error(
    "verify:ios-simulator requires an installed iOS Simulator runtime and iPhone device type; no runtime will be downloaded.",
  );

const temporary = await mkdtemp(join(tmpdir(), "rea-ios-simulator-verifier-"));
const app = join(temporary, "ReaDisplayFixture.app");
let udid;
let client;
let transport;
try {
  await mkdir(app);
  await copyFile(join(fixture, "Info.plist"), join(app, "Info.plist"));
  await command(
    swiftc,
    [
      "-parse-as-library",
      "-module-name",
      "ReaDisplayFixture",
      "-sdk",
      sdk,
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios16.0-simulator`,
      join(fixture, "DisplayFixture.swift"),
      "-o",
      join(app, "ReaDisplayFixture"),
    ],
    120_000,
  );
  await command(
    swiftc,
    [
      "-sdk",
      macSdk,
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos15.0`,
      join(fixture, "VerifyDisplay.swift"),
      "-o",
      join(temporary, "verify-display"),
    ],
    120_000,
  );
  const created = await command(
    "/usr/bin/xcrun",
    [
      "simctl",
      "create",
      `REA owned display verifier ${process.pid}`,
      choice.device.deviceTypeIdentifier,
      choice.runtime,
    ],
    60_000,
  );
  udid = created.stdout.trim();
  assert.match(udid, UUID);
  await command("/usr/bin/xcrun", ["simctl", "boot", udid], 60_000);
  await command(
    "/usr/bin/xcrun",
    ["simctl", "bootstatus", udid, "-b"],
    300_000,
  );
  await command("/usr/bin/xcrun", ["simctl", "install", udid, app], 300_000);
  await command(
    "/usr/bin/xcrun",
    ["simctl", "launch", udid, "io.github.morluto.rea.simulator.fixture"],
    60_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const cliOutput = await command(
    process.execPath,
    [entrypoint, "capture-ios-simulator-screen", udid, "--json"],
    120_000,
  );
  const cliEvidence = parseEvidence(JSON.parse(cliOutput.stdout));
  assert.equal(cliEvidence.operation, "capture_ios_simulator_screen");
  assert.equal(cliEvidence.provider.id, "apple-core-simulator");
  const cliCapture = iosSimulatorCaptureResultSchema.parse(
    cliEvidence.normalized_result,
  );
  assert.equal(cliCapture.simulator.udid, udid);
  assert.equal(cliCapture.foreground_application, null);
  await checkCapture(cliCapture, "cli");

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
  });
  client = new Client({ name: "rea-ios-simulator-verifier", version: "1" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(
    tools.tools.some((tool) => tool.name === "capture_ios_simulator_screen"),
  );
  const called = await client.callTool({
    name: "capture_ios_simulator_screen",
    arguments: { simulator_udid: udid },
  });
  assert.notEqual(
    called.isError,
    true,
    JSON.stringify(called.structuredContent),
  );
  const mcpEvidence = parseEvidence(called.structuredContent);
  const mcpCapture = iosSimulatorCaptureResultSchema.parse(
    mcpEvidence.normalized_result,
  );
  assert.deepEqual(mcpEvidence.normalized_result, mcpCapture);
  await checkCapture(mcpCapture, "mcp");

  const missing = await client.callTool({
    name: "capture_ios_simulator_screen",
    arguments: { simulator_udid: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(missing.isError, true);
  const errorContent = missing.content[0];
  assert.equal(errorContent?.type, "text");
  assert.equal(JSON.parse(errorContent.text).error.code, "unsupported_target");
  process.stdout.write(
    `Real iOS Simulator display verified: ${udid}; CLI and MCP PNG bytes, digests, Evidence, source-owned UI pixels, and missing-target failure.\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  if (udid !== undefined) {
    await command("/usr/bin/xcrun", ["simctl", "shutdown", udid], 60_000).catch(
      () => undefined,
    );
    await command("/usr/bin/xcrun", ["simctl", "delete", udid], 60_000);
  }
  await rm(temporary, { recursive: true, force: true });
}

async function checkCapture(capture, lane) {
  const bytes = Buffer.from(capture.screenshot.base64, "base64");
  assert.equal(bytes.byteLength, capture.screenshot.byte_length);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    capture.screenshot.sha256,
  );
  const path = join(temporary, `${lane}.png`);
  await writeFile(path, bytes);
  await command(join(temporary, "verify-display"), [path], 30_000);
}

async function command(binary, args, timeout = 30_000) {
  return execute(binary, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
}
