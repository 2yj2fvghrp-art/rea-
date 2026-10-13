import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { withCommands } from "../command-scope.mjs";
import { projectDump, uniqueControl, XML_BYTES } from "./hierarchy.mjs";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    output: { type: "string" },
  },
});
for (const name of ["serial", "apk", "output"])
  if (!values[name]) throw new Error(`Missing --${name}`);
const serial = values.serial;
const output = resolve(values.output);
await mkdir(output);
const packageName = "com.rea.ui.probe";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const client = new Client({ name: "adb-ui-scope-probe", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const call = async (name, input) => {
  const reply = await client.callTool(
    { name, arguments: input },
    { timeout: 120_000 },
  );
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  const text = reply.content.find((part) => part.type === "text")?.text;
  return toolContract(name).outputSchema.parse(
    reply.structuredContent ?? JSON.parse(text),
  );
};
let installed = false;
const receipts = [];
let installation;
await client.connect(transport);
try {
  await withCommands(async (run) => {
    const adb = (args) =>
      run(process.env.REA_ADB_PATH ?? "adb", ["-s", serial, ...args], {
        maxBytes: XML_BYTES,
      });
    assert.equal(
      (await adb(["shell", "getprop", "ro.kernel.qemu"])).stdout.trim(),
      "1",
      "This experiment requires an emulator",
    );
    const present = await call("resolve_adb_packages", {
      serial,
      query: packageName,
    });
    assert.equal(
      present.normalized_result.matches.length,
      0,
      "The fixture package must not already be installed",
    );
    const cli = await run(
      process.execPath,
      [
        resolve("scripts/rea.mjs"),
        "install-adb-package",
        serial,
        resolve(values.apk),
        "--json",
      ],
      { timeoutMs: 120_000 },
    );
    installation = toolContract("install_adb_package").outputSchema.parse(
      JSON.parse(cli.stdout),
    );
    installed = true;
    await call("start_adb_app", { serial, package: packageName });
    const cliFocus = await run(process.execPath, [
      resolve("scripts/rea.mjs"),
      "inspect-adb-window",
      serial,
      "--json",
    ]);
    const cliEvidence = toolContract("inspect_adb_window").outputSchema.parse(
      JSON.parse(cliFocus.stdout),
    );
    const mcpEvidence = await call("inspect_adb_window", { serial });
    assert.deepEqual(
      cliEvidence.normalized_result,
      mcpEvidence.normalized_result,
    );
    const focus = async (expected = packageName) => {
      const evidence = await call("inspect_adb_window", { serial });
      assert(
        evidence.normalized_result.focused_window?.includes(` ${expected}/`),
        "Foreground target is unresolved or changed",
      );
      return evidence;
    };
    const hierarchy = async () => {
      const started = performance.now();
      const capturedAt = new Date().toISOString();
      const captured = await adb([
        "exec-out",
        "uiautomator",
        "dump",
        "--compressed",
        "/proc/self/fd/1",
      ]);
      const parsed = projectDump(captured.stdout);
      if (!parsed.ok) throw new Error(parsed.error.reason);
      receipts.push({
        kind: "hierarchy",
        captured_at: capturedAt,
        elapsed_ms: performance.now() - started,
        bytes: Buffer.byteLength(captured.stdout),
        snapshot: parsed.value,
      });
      return parsed.value;
    };
    const control = (snapshot, name) => {
      const selected = uniqueControl(snapshot, packageName, name);
      assert.equal(selected.ok, true, JSON.stringify(selected));
      return selected.value;
    };
    const tap = async (name) => {
      const snapshot = await hierarchy();
      const { bounds } = control(snapshot, name);
      const focusEvidence = await focus();
      await adb([
        "shell",
        "input",
        "tap",
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
      ]);
      receipts.push({
        kind: "tap-dispatched",
        control: name,
        source_snapshot: snapshot.xml_sha256,
        focus_evidence: focusEvidence,
      });
    };
    await assert.rejects(
      () => focus("com.rea.not-the-target"),
      /unresolved or changed/u,
    );
    await tap("rea-tap");
    assert.equal(
      control(await hierarchy(), "rea-status").attributes.text,
      "Tapped 1",
    );
    await tap("rea-input");
    await focus();
    await adb(["shell", "input", "text", "REA%stext"]);
    assert.equal(
      control(await hierarchy(), "rea-input").attributes.text,
      "REA text",
    );
    await focus();
    await adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
    const before = await hierarchy();
    const { bounds } = control(before, "rea-scroll");
    await focus();
    const x = String(Math.floor((bounds.left + bounds.right) / 2));
    await adb([
      "shell",
      "input",
      "swipe",
      x,
      String(bounds.bottom - 80),
      x,
      String(bounds.top + 80),
      "300",
    ]);
    const after = await hierarchy();
    const rows = (snapshot) =>
      snapshot.nodes
        .map((node) => node.attributes.text)
        .filter((text) => /^Row \d+$/u.test(text ?? ""));
    assert.notDeepEqual(rows(before), rows(after));
    const screen = await call("capture_adb_screen", {
      serial,
      output_directory: output,
    });
    assert(screen.normalized_result);
    await writeFile(
      join(output, "receipt.json"),
      JSON.stringify(
        {
          scope: "unshipped prototype",
          serial,
          package: packageName,
          apk_bytes: (await readFile(values.apk)).length,
          installation,
          cli_mcp_focus_parity: true,
          tap_observed: true,
          text_observed: true,
          swipe_observed: true,
          keyevent_dispatched: true,
          screenshot_evidence: screen,
          tokens: "unmeasured",
          process_family_peak: "unmeasured",
          receipts,
        },
        null,
        2,
      ),
    );
    console.log(
      "UI prototype: observed tap/text/swipe outcomes, key-event dispatch, CLI/MCP focus parity and screenshot passed",
    );
  });
} finally {
  try {
    if (installed) {
      await call("uninstall_adb_package", { serial, package: packageName });
      const remaining = await call("resolve_adb_packages", {
        serial,
        query: packageName,
      });
      assert.equal(
        remaining.normalized_result.matches.length,
        0,
        "Fixture package cleanup failed",
      );
    }
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
}
