import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains child options with omitted argv through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-options-");
    await writeFixtureFiles(root, {
      "app/entry.mjs": [
        'import { spawn, execFile, fork } from "node:child_process";',
        'spawn("short-spawn", { env: { REA_FLAG: "1" }, stdio: "pipe" });',
        'execFile("short-exec", { env: { REA_FLAG: "1" } });',
        'fork("short-fork", { env: { REA_FLAG: "1" }, stdio: ["pipe", "pipe", "pipe", "ipc"] });',
        'spawn("long-spawn", [], { env: { REA_FLAG: "1" }, stdio: "pipe" });',
        'execFile("long-exec", [], { env: { REA_FLAG: "1" } });',
        'fork("long-fork", [], { env: { REA_FLAG: "1" }, stdio: ["pipe", "pipe", "pipe", "ipc"] });',
        'spawn("omitted");',
      ].join("\n"),
      "child.cjs": "process.stdout.write(process.env.REA_FLAG);",
      "control.cjs": [
        'const { spawn, execFile, fork } = require("node:child_process");',
        'const { join } = require("node:path");',
        'const receive = (child, input) => new Promise((resolve, reject) => { let text = ""; child.on("error", reject); child.stdout.on("data", (data) => { text += data; }); child.on("close", (code) => code === 0 ? resolve(text) : reject(new Error(String(code)))); if (input !== undefined) child.stdin.end(input); });',
        'const input = "process.stdout.write(process.env.REA_FLAG);";',
        '(async () => { const values = []; values.push(await receive(spawn(process.execPath, { env: { REA_FLAG: "spawn" }, stdio: "pipe" }), input)); values.push(await receive(execFile(process.execPath, { env: { REA_FLAG: "exec" } }), input)); values.push(await receive(fork(join(__dirname, "child.cjs"), { env: { REA_FLAG: "fork" }, stdio: ["pipe", "pipe", "pipe", "ipc"] }))); console.log(JSON.stringify(values)); })().catch((error) => { console.error(error); process.exitCode = 1; });',
      ].join("\n"),
    });
    const control = await execute(process.execPath, [
      join(root, "control.cjs"),
    ]);
    expect(JSON.parse(control.stdout)).toEqual(["spawn", "exec", "fork"]);
    const graph = (
      await analyzeJavaScriptDirectory(surface, cli, join(root, "app"))
    ).semantic_graph;
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(7);
    for (const [suffix, method, stdio] of [
      ["spawn", "spawn", "pipe"],
      ["exec", "execFile", "default"],
      ["fork", "fork", "array"],
    ]) {
      for (const prefix of ["short", "long"]) {
        const child = children.find(
          (node) => node.properties.command === `${prefix}-${suffix}`,
        );
        expect(child?.properties).toMatchObject({
          method,
          environment_supplied: true,
          stdio_mode: stdio,
        });
        expect(
          graph.relations.some(
            (relation) =>
              relation.relation === "supplies-env" &&
              relation.target_node_id === child?.node_id,
          ),
        ).toBe(true);
      }
    }
    expect(
      children.find((node) => node.properties.command === "omitted")
        ?.properties,
    ).toMatchObject({ environment_supplied: false, stdio_mode: "default" });
  },
);
