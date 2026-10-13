import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

/**
 * Regression tests for https://github.com/morluto/rea/issues/2890: the
 * application graph must not invent a CommonJS `imports` edge for a `require`
 * call whose callee resolves to a lexically shadowing local binding. The
 * static findings are the producing boundary, so the tests assert on the
 * recovered `require` references directly.
 */
const requireSpecifiers = (source: string): readonly (string | null)[] =>
  analyzeJavaScriptStaticSource(source)
    .references.filter((reference) => reference.kind === "require")
    .map((reference) => reference.specifier);

describe("lexically shadowed require calls", () => {
  it.each([
    [
      "function parameter",
      `function run(require) {\n  return require("./ghost.cjs");\n}\nconsole.log(run(() => "local"));`,
    ],
    [
      "optional call with function parameter",
      `function run(require) {\n  return require?.("./ghost.cjs");\n}`,
    ],
    [
      "destructured parameter",
      `function load({ require }) { return require("./throwing.cjs"); }\nconsole.log(load({ require: () => "local" }));`,
    ],
    [
      "hoisted function declaration",
      `function load() {\n  console.log(require("./throwing.cjs"));\n  function require() { return "local"; }\n}\nload();`,
    ],
    [
      "catch binding",
      `try { throw () => "local"; }\ncatch (require) { console.log(require("./throwing.cjs")); }`,
    ],
    [
      "block-scoped binding",
      `{ const require = () => "local";\n  console.log(require("./throwing.cjs")); }`,
    ],
    [
      "initialized top-level var",
      `var require = () => "local";\nconsole.log(require("./throwing.cjs"));`,
    ],
  ])("emits no require reference for a %s shadow", (_label, source) => {
    expect(requireSpecifiers(source)).toEqual([]);
  });

  it.each([
    [
      "ordinary unbound call",
      `const value = require("./real.cjs");`,
      ["./real.cjs"],
    ],
    [
      "optional unbound call",
      `const value = require?.("./real.cjs");`,
      ["./real.cjs"],
    ],
    [
      "uninitialized top-level var retains the wrapper loader",
      `var require;\nconsole.log(require("./loaded.cjs"));`,
      ["./loaded.cjs"],
    ],
    [
      "direct createRequire binding",
      `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst value = require("./dep.cjs");`,
      ["./dep.cjs"],
    ],
    [
      "createRequire binding behind erased TypeScript syntax",
      `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url) as NodeRequire;\nconst value = require("./dep.cjs");`,
      ["./dep.cjs"],
    ],
    [
      "loader call before reassignment",
      `require?.("./dep");\nrequire = localLoader;`,
      ["./dep"],
    ],
    [
      "eager computed method key before reassignment",
      `const routes = { [require?.("./dep")]() {} };\nrequire = localLoader;`,
      ["./dep"],
    ],
  ])("keeps the require reference for %s", (_label, source, expected) => {
    expect(requireSpecifiers(source)).toEqual(expected);
  });

  it("keeps only the genuine call in a mixed file", () => {
    expect(
      requireSpecifiers(
        `console.log(require("./loaded.cjs"));\nfunction load(require) { return require("./throwing.cjs"); }\nconsole.log(load(() => "local"));`,
      ),
    ).toEqual(["./loaded.cjs"]);
  });

  it("keeps the loader call before a write but not the call after it", () => {
    expect(
      requireSpecifiers(
        `var require;\nrequire("./before.cjs");\nrequire = localLoader;\nrequire("./after.cjs");`,
      ),
    ).toEqual(["./before.cjs"]);
  });
});
