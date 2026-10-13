#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTarget, renderPlan, availableCategories } from "./rel/intake.mjs";

const repo = dirname(fileURLToPath(import.meta.url));
const help = `REL — understand software without learning every analysis tool first.

Usage:
  node rel.mjs demo                  Preview our controlled demo
  node rel.mjs demo --run --out DIR  Run the real REA engine on our demo only
  node rel.mjs inspect TARGET       Identify a local artifact or website URL
  node rel.mjs inspect TARGET --question "How does search work?"
  node rel.mjs inspect TARGET --json
  node rel.mjs types                 Show the current analysis categories

Defaults are PREVIEW-ONLY. This command never fetches websites, installs providers,
changes agent configuration, or executes unknown target programs. --run is only
accepted for the source-owned demonstration; output must be outside the fork.
`;

function options(args) {
  const values = { json: false, run: false, out: null, question: null, positional: [] };
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg === "--json") values.json = true;
    else if (arg === "--run") values.run = true;
    else if (["--out", "--question", "-q"].includes(arg)) {
      if (!args[i+1] || args[i+1].startsWith("--")) throw new Error(`${arg} requires a value.`);
      values[arg === "--out" ? "out" : "question"] = args[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else values.positional.push(arg);
  }
  return values;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help); process.exit(0);
  }
  const settings = options(args);
  let [mode, target] = settings.positional;
  if (mode === "types" && settings.positional.length === 1 && !settings.run && !settings.out) {
    const list = availableCategories();
    console.log(settings.json ? JSON.stringify(list, null, 2) : list.map((x) => `${x.label} — ${x.capability}`).join("\n"));
  } else if (mode === "demo" && settings.positional.length === 1) {
    const lab = resolve(repo, "experiments/rel-first-lab");
    if (settings.run) {
      if (!settings.out) throw new Error("Demo execution requires --out DIR outside the REL repository.");
      if (settings.json) throw new Error("--json is available for preview only; the real run saves its own reports.");
      console.log("Running the source-owned REL lab with the locally built REA CLI (not another project).");
      const result = spawnSync(process.execPath, [resolve(repo, "experiments/rel-first-lab/run-real-analysis.mjs"), resolve(settings.out)], {cwd:repo,stdio:"inherit",timeout:240000});
      if (result.error || result.status !== 0) throw new Error(`REL demo run failed (exit ${result.status}, signal ${result.signal ?? "none"}): ${result.error?.message ?? "see output above"}`);
    } else {
      if (settings.out) throw new Error("--out is only meaningful with demo --run.");
      const plan = classifyTarget(lab);
      console.log(settings.json ? JSON.stringify({ ...plan, question:settings.question, safe_demo:true },null,2) : renderPlan(plan, settings.question)+"\n\nTo actually test REA here: node rel.mjs demo --run --out /tmp/rel-evidence");
    }
  } else {
    if (mode === "inspect") {
      if (!target || settings.positional.length !== 2) throw new Error("Usage: node rel.mjs inspect TARGET");
    } else {
      if (settings.positional.length !== 1) throw new Error("Choose one target, not several.");
      target = mode;
    }
    if (settings.run || settings.out) throw new Error("Analysis execution is only enabled for the REL-owned demo in this version. Inspection is preview-only.");
    const plan = classifyTarget(target);
    console.log(settings.json ? JSON.stringify({...plan,question:settings.question,execution:"preview-only"},null,2) : renderPlan(plan, settings.question));
  }
} catch (error) {
  console.error(`REL: ${error.message}`);
  process.exitCode = 2;
}
