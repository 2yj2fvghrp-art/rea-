import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  origin,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("CommonJS dependency links", () => {
  it.each([
    'require("dependency");',
    'void require("dependency");',
    'consume(require("dependency"));',
    'require("dependency").member;',
    'require("dependency")[key];',
    'const {} = require("dependency");',
    'const [] = require("dependency");',
    'let assigned; assigned = require("dependency");',
    'function run(value = require("dependency")) {}',
    '(require("dependency") as unknown);',
  ])("retains an unbound dependency in %s", (source) => {
    const ir = analyzeJavaScriptSemantics(source);
    expect(ir.moduleLinks).toEqual([
      expect.objectContaining({
        kind: "require",
        specifier: "dependency",
        importedName: null,
        localName: null,
        exportedName: null,
        callableId: null,
      }),
    ]);
  });

  it.each([
    'function run(require) { require("dependency"); }',
    'require("dependency"); const require = loader;',
    'function run() { require("dependency"); var require; }',
    'with (environment) { require("dependency"); }',
    "require(dynamicSpecifier);",
  ])("does not invent a static global dependency in %s", (source) => {
    expect(analyzeJavaScriptSemantics(source).moduleLinks).toEqual([]);
  });

  it("keeps bindings and re-exports without extra dependency links", () => {
    const ir = analyzeJavaScriptSemantics(`
      const bound = (require("bound") as unknown);
      const { left, right } = require("destructured");
      module.exports = require("forwarded");
      exports.member = require("member").value;
      exports.first = exports.second = require("chained");
    `);
    expect(
      ir.moduleLinks.map(({ kind, specifier, localName, exportedName }) => ({
        kind,
        specifier,
        localName,
        exportedName,
      })),
    ).toEqual([
      {
        kind: "require",
        specifier: "bound",
        localName: "bound",
        exportedName: null,
      },
      {
        kind: "require",
        specifier: "destructured",
        localName: "left",
        exportedName: null,
      },
      {
        kind: "require",
        specifier: "destructured",
        localName: "right",
        exportedName: null,
      },
      {
        kind: "commonjs-export",
        specifier: "forwarded",
        localName: null,
        exportedName: "default",
      },
      {
        kind: "commonjs-export",
        specifier: "member",
        localName: null,
        exportedName: "member",
      },
      {
        kind: "commonjs-export",
        specifier: "chained",
        localName: null,
        exportedName: "first",
      },
      {
        kind: "commonjs-export",
        specifier: "chained",
        localName: null,
        exportedName: "second",
      },
    ]);
    expect(
      ir.bindings.find(({ name }) => name === "bound")?.provenance.origins,
    ).toEqual([{ specifier: "bound", importedPath: [] }]);
  });

  it.each([
    'require("outer", require("inner"));',
    'const bound = require("outer", require("inner"));',
    'module.exports = require("outer", require("inner"));',
  ])("retains a distinct nested call in %s", (source) => {
    const links = analyzeJavaScriptSemantics(source).moduleLinks;
    expect(links.map(({ specifier }) => specifier)).toEqual(["outer", "inner"]);
    expect(links[1]).toMatchObject({
      kind: "require",
      importedName: null,
      localName: null,
      exportedName: null,
    });
  });
});

it("preserves unshadowed require origins through aliases and assignments", () => {
  const ir = analyzeJavaScriptSemantics(`
    const { ipcMain: bus } = require("electron");
    const forwarded = bus;
    let assigned;
    assigned = require("electron").ipcMain;
    { const require = localLoader; require("./local.js"); }
  `);
  for (const name of ["bus", "forwarded"])
    expect(origin(topLevelBinding(ir, name))).toEqual({
      specifier: "electron",
      importedPath: ["ipcMain"],
    });
  expect(topLevelBinding(ir, "assigned").provenance).toMatchObject({
    status: "ambiguous",
    origins: [{ specifier: "electron", importedPath: ["ipcMain"] }],
  });
  expect(ir.moduleLinks.filter(({ kind }) => kind === "require")).toEqual([
    expect.objectContaining({
      specifier: "electron",
      importedName: "ipcMain",
      localName: "bus",
    }),
    expect.objectContaining({
      specifier: "electron",
      importedName: null,
      localName: null,
    }),
  ]);
});

it("retains import-equals value dependencies without inventing erased ones", () => {
  const ir = analyzeJavaScriptSemantics(`
    import value = require("dependency");
    import type erased = require("type-only-dependency");
    import alias = Internal.Namespace;
    void value; void erased; void alias;
  `);

  expect(
    ir.moduleLinks.map(({ kind, specifier, importedName, localName }) => ({
      kind,
      specifier,
      importedName,
      localName,
    })),
  ).toEqual([
    {
      kind: "require",
      specifier: "dependency",
      importedName: "*",
      localName: "value",
    },
  ]);

  const programScope = ir.scopes.find(
    ({ kind }) => kind === "program",
  )?.scopeId;
  expect(
    ir.bindings
      .filter(({ scopeId }) => scopeId === programScope)
      .map(({ name, kind, mutable }) => ({ name, kind, mutable })),
  ).toEqual([
    { name: "alias", kind: "import", mutable: false },
    { name: "erased", kind: "import", mutable: false },
    { name: "value", kind: "import", mutable: false },
  ]);

  expect(
    ir.bindings.find(({ name }) => name === "value")?.provenance,
  ).toMatchObject({
    status: "module",
    origins: [{ specifier: "dependency", importedPath: [] }],
  });
  for (const name of ["erased", "alias"])
    expect(
      ir.bindings.find((binding) => binding.name === name)?.provenance,
    ).toMatchObject({ status: "local", origins: [] });

  const aliases = ir.references.filter(({ name }) =>
    ["alias", "erased", "value"].includes(name),
  );
  expect(aliases.length).toBeGreaterThan(0);
  expect(aliases.every(({ resolution }) => resolution === "resolved")).toBe(
    true,
  );
});
