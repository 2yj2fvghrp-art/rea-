import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { withCommands } from "../command-scope.mjs";
import { projectDump, uniqueControl, actionPoints } from "./hierarchy.mjs";
import { withFixture } from "./fixture.mjs";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
  },
});
for (const name of ["serial", "apk", "output"])
  if (!values[name]) throw new Error(`Missing --${name}`);
const serial = values.serial;
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
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
const receipts = [];
const receipt = await withCommands((run, signal) =>
  withFixture(
    {
      apk: values.apk,
      aapt2: values.aapt2,
      output,
      serial,
      environment: env,
      client,
      transport,
      run,
      signal,
    },
    async ({ call, adb, installation, fixture }) => {
      const packageName = fixture.package;
      let screens = 0;
      const capture = () =>
        call("capture_adb_screen", {
          serial,
          output_directory: join(output, `screen-${screens++}`),
        });
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
      const action = async (snapshot, name, kind) => {
        const selected = control(snapshot, name);
        // PNG dimensions are in current screen orientation; wm size can describe
        // natural orientation instead. Retain the observation used for the guard.
        const display = await capture();
        const points = actionPoints(selected, display.normalized_result, kind);
        assert.equal(points.ok, true, JSON.stringify(points));
        const focusEvidence = await focus();
        await adb([
          "shell",
          "input",
          kind,
          ...points.value.flatMap(({ x, y }) => [String(x), String(y)]),
          ...(kind === "swipe" ? ["300"] : []),
        ]);
        receipts.push({
          kind: `${kind}-dispatched`,
          control: name,
          points: points.value,
          source_snapshot: snapshot.xml_sha256,
          focus_evidence: focusEvidence,
          display_evidence: display,
        });
      };
      await assert.rejects(
        () => focus("com.rea.not-the-target"),
        /unresolved or changed/u,
      );
      await action(await hierarchy(), "rea-tap", "tap");
      assert.equal(
        control(await hierarchy(), "rea-status").attributes.text,
        "Tapped 1",
      );
      await action(await hierarchy(), "rea-input", "tap");
      await focus();
      await adb(["shell", "input", "text", "REA%stext"]);
      assert.equal(
        control(await hierarchy(), "rea-input").attributes.text,
        "REA text",
      );
      await focus();
      await adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
      const before = await hierarchy();
      await action(before, "rea-scroll", "swipe");
      const after = await hierarchy();
      const rows = (snapshot) =>
        snapshot.nodes
          .map((node) => node.attributes.text)
          .filter((text) => /^Row \d+$/u.test(text ?? ""));
      assert.notDeepEqual(rows(before), rows(after));
      const screen = await capture();
      assert(screen.normalized_result);
      return {
        scope: "unshipped prototype",
        serial,
        package: packageName,
        fixture,
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
      };
    },
  ),
);
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(
  "UI prototype: observed tap/text/swipe outcomes, key-event dispatch, CLI/MCP focus parity, screenshot and fixture cleanup passed",
);
