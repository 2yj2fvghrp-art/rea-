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

const shadowedCases = [
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
  [
    "top-level let binding",
    `export {}; let require; require?.("./ghost.cjs");`,
  ],
  [
    "nested shadow inside a require-named bundle factory",
    `globalThis.webpackChunkApp.push([[1], { entry(module, exports, require) { function inner(require) { return require("./nested.cjs"); } } }]);`,
  ],
  [
    "factory loader parameter replaced by a hoisted function declaration",
    `globalThis.webpackChunkApp.push([[1], { entry(module, exports, require) { function require() { return "local"; } require("ghost"); } }]);`,
  ],
  [
    "destructured missing property of createRequire",
    `import { createRequire } from "node:module";\nconst { missing: require } = createRequire(import.meta.url);\nrequire?.("./ghost.cjs");`,
  ],
  [
    "object-rest declaration",
    `var {...require} = {};\nrequire?.("./ghost.cjs");`,
  ],
  [
    "array-rest declaration",
    `var [...require] = [];\nrequire?.("./ghost.cjs");`,
  ],
  [
    "for-of write before the call in the loop body",
    `var require;\nfor (require of [() => "local"]) { require("./ghost.cjs"); }`,
  ],
  [
    "for-in write before the call in the loop body",
    `var require;\nfor (require in { a: 1 }) { require("./ghost.cjs"); }`,
  ],
  [
    "call after a for-of write",
    `var require;\nfor (require of [() => "local"]) {}\nrequire("./after.cjs");`,
  ],
];

const loaderCases = [
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
  [
    "bundle factory whose loader parameter is named require",
    `globalThis.webpackChunkApp.push([[1], { entry(module, exports, require) { require("dep"); } }]);`,
    ["dep"],
  ],
  [
    "bundle factory loader call next to a nested shadow",
    `globalThis.webpackChunkApp.push([[1], { entry(module, exports, require) { require("dep"); function inner(require) { return require("./nested.cjs"); } } }]);`,
    ["dep"],
  ],
  [
    "namespace createRequire binding",
    `import * as module from "node:module";\nconst require = module.createRequire(import.meta.url);\nrequire("./dep.cjs");`,
    ["./dep.cjs"],
  ],
  [
    "call inside the right-hand side of its own reassignment",
    `var require; require = require("./dep.cjs");`,
    ["./dep.cjs"],
  ],
  [
    "top-level call before a deferred write",
    `var require;\nfunction f() { require = localLoader; }\nrequire("./dep.cjs");`,
    ["./dep.cjs"],
  ],
  [
    "call before a for-of write",
    `var require;\nrequire("./before.cjs");\nfor (require of [() => "local"]) { require("./ghost.cjs"); }`,
    ["./before.cjs"],
  ],
  [
    "call before a for-in write",
    `var require;\nrequire("./before.cjs");\nfor (require in { a: 1 }) { require("./ghost.cjs"); }`,
    ["./before.cjs"],
  ],
  [
    "iterable call of a for-of loop sees the loader",
    `var require;\nfor (require of require("./iter.cjs")) { require("./ghost.cjs"); }`,
    ["./iter.cjs"],
  ],
];

describe("lexically shadowed require calls", () => {
  it.each(shadowedCases)(
    "emits no require reference for a %s shadow",
    (_label, source) => {
      expect(requireSpecifiers(source)).toEqual([]);
    },
  );

  it.each(loaderCases)(
    "keeps the require reference for %s",
    (_label, source, expected) => {
      expect(requireSpecifiers(source)).toEqual(expected);
    },
  );

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

  it("drops the call after a write in the same function body", () => {
    expect(
      requireSpecifiers(
        `var require;\nfunction f() { require = localLoader; return require("./x.cjs"); }\nf();`,
      ),
    ).toEqual([]);
  });
});
