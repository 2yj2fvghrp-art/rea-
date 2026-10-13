#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyTarget,
  renderPlan,
  availableCategories,
} from "./rel/intake.mjs";
import { runStaticAnalysis } from "./rel/analyze-static.mjs";
import { startLabServer, openLabInBrowser } from "./rel/lab-server.mjs";

const repo = dirname(fileURLToPath(import.meta.url));
const help = [
  "REL — a simple front door to the local REA analysis engine.",
  "",
  "node rel.mjs types                              Supported target families",
  "node rel.mjs inspect TARGET --question TEXT     Classify without running tools",
  "node rel.mjs demo                               Preview our own lab",
  "node rel.mjs lab [--open]                       Open visual learning lab locally",
  "node rel.mjs demo --run --out DIR                Run our verified lab",
  "node rel.mjs analyze TARGET --authorized --out DIR [--question TEXT]",
  "                                                Static JavaScript/Electron folder or ASAR",
  "node rel.mjs codex                              Check Codex project setup",
  "",
  "All output goes outside the REL repository. Other target families use REA's",
  "documented providers/MCP tools, not a fabricated universal analyzer.",
].join("\n");

function options(args) {
  const values = {
    json: false,
    run: false,
    authorized: false,
    open: false,
    out: null,
    question: null,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") values.json = true;
    else if (arg === "--run") values.run = true;
    else if (arg === "--authorized") values.authorized = true;
    else if (arg === "--open") values.open = true;
    else if (["--out", "--question", "-q"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(arg + " requires a value.");
      values[arg === "--out" ? "out" : "question"] = args[++i];
    } else if (arg.startsWith("-")) throw new Error("Unknown option: " + arg);
    else values.positional.push(arg);
  }
  return values;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
  } else {
    const settings = options(args);
    const [mode, target] = settings.positional;
    if (settings.open && mode !== "lab")
      throw new Error("--open is available only for the local visual lab.");
    if (mode === "types" && settings.positional.length === 1) {
      if (settings.run || settings.authorized || settings.out)
        throw new Error("types is preview-only.");
      const list = availableCategories();
      console.log(
        settings.json
          ? JSON.stringify(list, null, 2)
          : list.map((x) => x.label + " — " + x.capability).join("\n"),
      );
    } else if (mode === "codex" && settings.positional.length === 1) {
      if (settings.run || settings.authorized || settings.out || settings.json)
        throw new Error("codex has no execution flags.");
      console.log(
        "REL / Codex workspace configuration: " +
          (existsSync(resolve(repo, ".codex/config.toml"))
            ? "present"
            : "not found"),
      );
      console.log(
        "REA compiled MCP runtime: " +
          (existsSync(resolve(repo, "dist/mcp/main.js"))
            ? "built"
            : "missing — run npm ci && npm run build:cached"),
      );
      console.log(
        "Open this REL checkout from its root in a trusted Codex workspace; check /mcp and use $rel-investigator.",
      );
      console.log(
        "Project settings are not your personal Codex config. Only this REL fork was changed.",
      );
    } else if (mode === "lab" && settings.positional.length === 1) {
      if (
        settings.run ||
        settings.authorized ||
        settings.out ||
        settings.json ||
        settings.question
      )
        throw new Error(
          "Use node rel.mjs lab [--open] with no analysis flags.",
        );
      const { url } = await startLabServer();
      console.log("REL Visual Lab — learn by seeing what the code does.");
      console.log("Open this local address: " + url);
      console.log(
        "No internet, target execution, global Codex installation, or other projects involved.",
      );
      console.log("Press Ctrl+C to close the local lab.");
      if (settings.open) openLabInBrowser(url);
    } else if (mode === "demo" && settings.positional.length === 1) {
      const lab = resolve(repo, "experiments/rel-first-lab");
      if (settings.run) {
        if (!settings.out || settings.authorized || settings.json)
          throw new Error(
            "Use demo --run --out DIR, without --authorized or --json.",
          );
        const child = spawnSync(
          process.execPath,
          [
            resolve(repo, "experiments/rel-first-lab/run-real-analysis.mjs"),
            resolve(settings.out),
          ],
          { cwd: repo, stdio: "inherit", timeout: 240000 },
        );
        if (child.error || child.status !== 0)
          throw new Error("REL demo run failed; see output and logs.");
      } else {
        if (settings.out || settings.authorized)
          throw new Error(
            "Demo preview does not accept --out or --authorized.",
          );
        const plan = classifyTarget(lab);
        console.log(
          settings.json
            ? JSON.stringify({ ...plan, safe_demo: true }, null, 2)
            : renderPlan(plan, settings.question) +
                "\n\nTo run: node rel.mjs demo --run --out /tmp/rel-evidence",
        );
      }
    } else if (
      mode === "analyze" &&
      target &&
      settings.positional.length === 2
    ) {
      if (settings.run)
        throw new Error("analyze uses --authorized (not --run).");
      const result = runStaticAnalysis({
        target,
        out: settings.out,
        authorized: settings.authorized,
        question: settings.question,
      });
      console.log(
        settings.json
          ? JSON.stringify(result, null, 2)
          : "REL static analysis verified: " +
              result.nodes +
              " graph nodes, " +
              result.edges +
              " edges.\nEvidence: " +
              result.evidence_id +
              "\nReport: " +
              result.report,
      );
    } else {
      if (mode === "inspect") {
        if (!target || settings.positional.length !== 2)
          throw new Error("Usage: node rel.mjs inspect TARGET");
      } else {
        if (settings.positional.length !== 1)
          throw new Error("Choose a single supported command or target.");
      }
      if (settings.run || settings.authorized || settings.out)
        throw new Error(
          "Analysis execution is only enabled for the REL-owned demo or via analyze --authorized for static JavaScript.",
        );
      const plan = classifyTarget(mode === "inspect" ? target : mode);
      console.log(
        settings.json
          ? JSON.stringify(
              {
                ...plan,
                question: settings.question,
                execution: "preview-only",
              },
              null,
              2,
            )
          : renderPlan(plan, settings.question),
      );
    }
  }
} catch (error) {
  console.error("REL: " + error.message);
  process.exitCode = 2;
}
