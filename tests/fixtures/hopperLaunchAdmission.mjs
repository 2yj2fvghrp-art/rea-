import { readFile, writeFile } from "node:fs/promises";

// Model the native helper's external GUI handoff independently of its lifetime.
const [modePath, receiptPath] = process.argv.slice(2, 4);
const mode = await readFile(modePath, "utf8");
const bootstrapIndex = process.argv.indexOf("-Y") + 1;
if (bootstrapIndex === 0) throw new Error("Missing Hopper bootstrap argument");
const bootstrapPath = process.argv[bootstrapIndex];
await writeFile(receiptPath, bootstrapPath);
if (mode === "denied") {
  process.stderr.write(
    "Cannot launch Hopper!\nNot authorized to send Apple events to Hopper Disassembler.\n",
    () => process.exit(2),
  );
} else if (mode === "handoff") {
  process.exit(0);
} else if (mode === "bridge") {
  await import("./fakeLauncher.mjs");
} else {
  throw new Error(`Unknown Hopper launch admission fixture mode: ${mode}`);
}
