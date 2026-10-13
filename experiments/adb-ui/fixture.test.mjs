import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { createEvidence } from "../../dist/domain/evidence.js";
import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";
import { withCommands } from "../command-scope.mjs";
import { FIXTURE_PACKAGE, withFixture } from "./fixture.mjs";

const identity = {
  binary_path: "adb",
  path_source: "path",
  version: "test",
  installed_path: null,
};
const evidence = (operation, parameters, result) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Scripted boundary", version: "1" },
    {
      operation,
      parameters,
      result,
      subjectUnavailableReason: "Synthetic lifecycle fixture",
    },
  );

// Real filesystem snapshots and MCP wire calls; device/inspector outcomes are
// scripted to reproduce failures a successful emulator run cannot establish.
async function harness(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "rea-ui-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apk = join(root, "source.apk");
  const output = join(root, "result");
  await mkdir(output);
  await writeFile(apk, "admitted fixture bytes");
  const state = {
    installed: settings.present ?? false,
    installs: 0,
    uninstalls: 0,
    inventories: 0,
    commands: [],
    calls: [],
  };
  const server = new McpServer({ name: "ui-lifecycle-fixture", version: "1" });
  const client = new Client({ name: "ui-lifecycle-test", version: "1" });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  for (const name of [
    "resolve_adb_packages",
    "uninstall_adb_package",
    "inspect_adb_window",
  ]) {
    server.registerTool(
      name,
      { inputSchema: toolContract(name).inputSchema },
      async (input, context) => {
        state.calls.push(name);
        let result;
        if (name === "resolve_adb_packages") {
          state.inventories++;
          result = {
            client: identity,
            serial: input.serial,
            query: input.query,
            matches: state.installed
              ? [
                  {
                    package_name: FIXTURE_PACKAGE,
                    base_apk_device_path: "/data/app/fixture/base.apk",
                  },
                ]
              : [],
            exact_match: state.installed,
            coverage: "complete",
            ...settings.inventory?.(state),
          };
        } else if (name === "uninstall_adb_package") {
          assert.equal(input.package, FIXTURE_PACKAGE);
          assert.equal(
            context.mcpReq.signal.aborted,
            false,
            "cleanup received workflow cancellation",
          );
          state.uninstalls++;
          if (settings.uninstallError) throw settings.uninstallError;
          state.installed = false;
          result = {
            client: identity,
            serial: input.serial,
            package_name: input.package,
          };
        } else {
          assert(settings.window, "unexpected window operation");
          await settings.window(context.mcpReq.signal);
          result = {
            client: identity,
            serial: input.serial,
            focused_window: null,
            focused_app: null,
            observed_lines: [],
          };
        }
        return {
          content: [],
          structuredContent: evidence(name, input, result),
        };
      },
    );
  }
  await server.connect(peer);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const run = async (command, args) => {
    state.commands.push({ command, args });
    if (command === "aapt2") {
      assert.deepEqual(args.slice(0, 2), ["dump", "packagename"]);
      assert.equal(await readFile(args[2], "utf8"), "admitted fixture bytes");
      await settings.afterInspection?.(apk);
      return {
        stdout: `${settings.package ?? FIXTURE_PACKAGE}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "-s") {
      assert.deepEqual(args.slice(2), ["shell", "getprop", "ro.kernel.qemu"]);
      return { stdout: "1\n", stderr: "", code: 0 };
    }
    assert.equal(command, process.execPath);
    assert.equal(args[1], "install-adb-package");
    const snapshot = args[3];
    assert.notEqual(snapshot, apk);
    assert.equal(await readFile(snapshot, "utf8"), "admitted fixture bytes");
    state.installs++;
    state.installed = true; // Device commit can precede any host outcome.
    if (settings.install) return settings.install(state);
    return {
      stdout: JSON.stringify(
        evidence(
          "install_adb_package",
          {},
          {
            client: identity,
            serial: args[2],
            apk_path: snapshot,
            ...(await hashStableFile(snapshot)),
            replaced: false,
          },
        ),
      ),
      stderr: "",
      code: 0,
    };
  };
  const options = {
    apk,
    aapt2: "aapt2",
    output,
    serial: "emulator-5554",
    environment: { REA_ADB_PATH: " \t" },
    client,
    transport,
    run,
    signal: new AbortController().signal,
  };
  return { options, state };
}

test("rejects other APK packages and incomplete or pre-existing inventory before installation", async (t) => {
  for (const settings of [
    { package: "com.other.app" },
    { inventory: () => ({ coverage: "partial", matches: [] }) },
    { present: true },
  ]) {
    const h = await harness(t, settings);
    await assert.rejects(
      withFixture(h.options, () => assert.fail("must not run")),
      /fixture package|incomplete|already be installed/u,
    );
    assert.equal(h.state.installs, 0);
    assert.equal(h.state.uninstalls, 0);
  }
});

test("installs the inspected snapshot even if the source is replaced, using canonical blank adb selection", async (t) => {
  const h = await harness(t, {
    afterInspection: (source) => writeFile(source, "replacement APK"),
  });
  const result = await withFixture(h.options, ({ fixture }) => fixture.source);
  assert.equal(h.state.commands[1].command, "adb");
  assert.equal(result.bytes, Buffer.byteLength("admitted fixture bytes"));
  assert.equal(await readFile(h.options.apk, "utf8"), "replacement APK");
  assert.equal(h.state.uninstalls, 1);
  assert.equal(h.state.installed, false);
  assert.equal(
    JSON.parse(
      await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
    ).status,
    "absent",
  );
});

test("reconciles a committed install after command cancellation, malformed JSON or invalid Evidence", async (t) => {
  const cancelled = new Error("install cancelled after device commit");
  for (const install of [
    () => {
      throw cancelled;
    },
    () => ({ stdout: "{broken" }),
    () => ({ stdout: "{}" }),
  ]) {
    const h = await harness(t, { install });
    await assert.rejects(
      withFixture(h.options, () => assert.fail("must not run")),
    );
    assert.equal(h.state.uninstalls, 1);
    assert.equal(h.state.installed, false);
    assert.equal(h.state.inventories, 3);
  }
});

test("partial post-uninstall inventory cannot prove cleanup or discard the retained owner", async (t) => {
  const h = await harness(t, {
    inventory: ({ inventories }) =>
      inventories === 3 ? { coverage: "partial", matches: [] } : {},
  });
  await assert.rejects(
    withFixture(h.options, () => "verified"),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /incomplete/u);
      assert.equal(error.cleanupOwner.package, FIXTURE_PACKAGE);
      assert.equal(error.cleanupOwner.serial, "emulator-5554");
      return true;
    },
  );
  assert.equal(
    JSON.parse(
      await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
    ).status,
    "install-attempted",
  );
});

test("retains the verification failure alongside uninstall and close failures", async (t) => {
  const primary = new Error("tap assertion failed");
  const closeError = new Error("client close failed");
  const h = await harness(t, { uninstallError: new Error("device offline") });
  const actualClose = h.options.client.close.bind(h.options.client);
  h.options.client.close = async () => {
    await actualClose();
    throw closeError;
  };
  try {
    await assert.rejects(
      withFixture(h.options, () => {
        throw primary;
      }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.match(error.errors[1].message, /device offline/u);
        assert.equal(error.errors[2], closeError);
        assert.equal(error.cleanupOwner.package, FIXTURE_PACKAGE);
        return true;
      },
    );
  } finally {
    h.options.client.close = actualClose;
  }
});

test("failed connection still attempts both closes and preserves all failures", async () => {
  const failures = [
    new Error("connect"),
    new Error("client close"),
    new Error("transport close"),
  ];
  await assert.rejects(
    withFixture(
      {
        output: "/unused",
        environment: {},
        signal: new AbortController().signal,
        client: {
          connect: async () => {
            throw failures[0];
          },
          close: async () => {
            throw failures[1];
          },
        },
        transport: {
          close: async () => {
            throw failures[2];
          },
        },
      },
      () => assert.fail("must not run"),
    ),
    (error) => {
      assert.deepEqual(error.errors, failures);
      assert.equal(error.cause, failures[0]);
      return true;
    },
  );
});

test(
  "SIGINT cancels an in-flight MCP request and cleanup uses an independent deadline",
  { timeout: 5_000 },
  async (t) => {
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const h = await harness(t, {
      window: async (signal) => {
        started.resolve();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        cancelled.resolve();
      },
    });
    const pending = withCommands((_run, signal) =>
      withFixture({ ...h.options, signal }, ({ call }) =>
        call("inspect_adb_window", { serial: h.options.serial }),
      ),
    );
    const rejected = assert.rejects(pending, /cancel/iu);
    await started.promise;
    process.emit("SIGINT");
    await rejected;
    await cancelled.promise;
    assert.equal(h.state.uninstalls, 1);
    assert.equal(h.state.installed, false);
  },
);
