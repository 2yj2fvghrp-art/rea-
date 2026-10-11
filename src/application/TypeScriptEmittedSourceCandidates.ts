import { posix } from "node:path";

/**
 * TypeScript source commonly names the extension emitted for NodeNext, so a
 * missing emitted name resolves to its present source counterpart: `./dep.js`
 * to `dep.ts`/`dep.tsx`/`dep.d.ts`, `./x.mjs` to `x.mts`/`x.d.mts`, `./x.cjs`
 * to `x.cts`/`x.d.cts`, and `./x.jsx` to `x.tsx`/`x.d.ts`. Candidates are
 * returned only for TypeScript-family callers and explicit filenames;
 * directory and index resolution never substitutes a counterpart, and any
 * present runtime file wins because callers try it first.
 */
export const typescriptEmittedSourceCandidates = (
  sourcePath: string,
  candidate: string,
): readonly string[] => {
  if (!/\.(?:ts|tsx|mts|cts)$/u.test(sourcePath)) return [];
  const suffixes = candidate.endsWith(".js")
    ? [".ts", ".tsx", ".d.ts"]
    : candidate.endsWith(".mjs")
      ? [".mts", ".d.mts"]
      : candidate.endsWith(".cjs")
        ? [".cts", ".d.cts"]
        : candidate.endsWith(".jsx")
          ? [".tsx", ".d.ts"]
          : [];
  if (suffixes.length === 0) return [];
  const stem = candidate.slice(0, -posix.extname(candidate).length);
  return suffixes.map((suffix) => `${stem}${suffix}`);
};
