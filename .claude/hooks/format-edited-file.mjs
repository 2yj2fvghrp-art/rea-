#!/usr/bin/env node
// PostToolUse hook: format the file Claude just edited with the pinned oxfmt.
// Never blocks the edit; formatting failures are reported on stderr only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

const FORMATTABLE = /\.(?:[cm]?[jt]sx?|json|md|ya?ml)$/i;

let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
const filePath = payload?.tool_input?.file_path;
if (typeof filePath !== "string" || !FORMATTABLE.test(filePath))
  process.exit(0);

const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
if (rel.startsWith("..") || !existsSync(join(root, rel))) process.exit(0);

const oxfmt = join(root, "node_modules", ".bin", "oxfmt");
if (!existsSync(oxfmt)) process.exit(0);

const result = spawnSync(oxfmt, ["--no-error-on-unmatched-pattern", rel], {
  cwd: root,
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(`oxfmt failed for ${rel}:\n${result.stderr ?? ""}`);
}
process.exit(0);
