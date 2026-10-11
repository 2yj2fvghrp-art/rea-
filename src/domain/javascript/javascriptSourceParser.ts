import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

/**
 * Babel plugins for one source path. Single owner for TypeScript/JSX
 * mode selection (tsc + Babel `typescript` plugin semantics).
 *
 * - `dts:true` only for `.d.ts/.d.mts/.d.cts` ambient declarations;
 *   ordinary `.ts` keeps the missing-initializer diagnostic.
 * - JSX enabled for `.tsx`, `.jsx`, `.js`, and unknown paths; disabled for
 *   plain `.ts/.cts/.mts` (angle-bracket assertions, not JSX) and for all
 *   declaration files. `.mts` (including `.d.mts`) sets
 *   `disallowAmbiguousJSXLike`, matching tsc's `.mts` mode.
 * - `decorators-legacy` always present: without it decorated sources fail
 *   hard instead of reporting recovered syntax, losing every derived fact.
 * - Unknown paths retain the existing JSX-capable contract (best-effort
 *   parse; failures surface via `errorRecovery`, never silent misparse).
 */
export const parserPluginsForPath = (sourcePath?: string): ParserPlugin[] => {
  const path = sourcePath ?? "";
  const dts = /\.d\.(?:ts|mts|cts)$/iu.test(path);
  const isTsLike = /\.(?:ts|cts|mts)$/iu.test(path);
  const isTsx = /\.tsx$/iu.test(path);
  const isMts = /\.mts$/iu.test(path);
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts,
      ...(isMts ? { disallowAmbiguousJSXLike: true } : {}),
    },
  ];
  const jsxCapable = !dts && (isTsx || !isTsLike);
  return jsxCapable
    ? ["decorators-legacy", "jsx", typescript]
    : ["decorators-legacy", typescript];
};

/**
 * Parse a module or script with recovery. Babel tries module mode first and
 * keeps its strict-mode errors after falling back to a script, so a script
 * with errors is parsed again as a script to report only its own errors.
 */
export const parseRecoveredJavaScript = (
  source: string,
  options: Omit<ParserOptions, "sourceType" | "errorRecovery">,
): ParsedJavaScriptSource => {
  const file = parse(source, {
    ...options,
    sourceType: "unambiguous",
    errorRecovery: true,
  });
  return file.program.sourceType === "script" && file.errors.length > 0
    ? parse(source, { ...options, sourceType: "script", errorRecovery: true })
    : file;
};

/** Parse JavaScript or TypeScript once without attaching comments to AST nodes. */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
): ParsedJavaScriptSource | null => {
  try {
    return parseRecoveredJavaScript(source, {
      attachComment: false,
      plugins: parserPluginsForPath(sourcePath),
    });
  } catch (cause: unknown) {
    // Unparseable source is represented by the null return.
    void cause;
    return null;
  }
};
