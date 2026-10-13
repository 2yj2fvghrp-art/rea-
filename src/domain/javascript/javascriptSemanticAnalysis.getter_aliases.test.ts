import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const returnedValue = (getter: string, write = "box.v.x = 2;") =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() {
      const shared = { x: 1, y: 1 };
      const box = { s: shared, get v() { ${getter} } };
      ${write}
      return shared.x;
    }`),
    "result",
  ).returnSites[0]?.value;

describe("getter-local receiver aliases (#2653)", () => {
  it.each([
    ["initialized alias", "const self = this; return self.s;"],
    ["assigned alias", "let self; self = this; return self.s;"],
    [
      "chained assignment",
      "let self; let alias; self = alias = this; return self.s;",
    ],
    ["destructured receiver", "const { s: value } = this; return value;"],
    ["alias chain", "const self = this; const saved = self; return saved.s;"],
    [
      "capture before reassignment",
      "let self = this; const saved = self; self = { s: { x: 1 } }; return saved.s;",
    ],
    [
      "conditional receiver alias",
      "const self = flag ? this : { s: { x: 1 } }; return self.s;",
    ],
  ])("invalidates shared values through %s", (_name, getter) => {
    expect(returnedValue(getter)?.status).toBe("unknown");
  });

  it.each([
    ["no write", "const self = this; return self.s;", "const saved = box.v;"],
    [
      "an unrelated property write",
      "const self = this; return self.s;",
      "box.v.y = 2;",
    ],
    [
      "a cycle that does not grow the selected path",
      "let self = this; while (flag) self = self; return self.s;",
      "box.v.y = 2;",
    ],
    [
      "an alias replaced before return",
      "let self = this; self = { s: { x: 1 } }; return self.s;",
      "box.v.x = 2;",
    ],
    [
      "a shadowing block binding",
      "const self = this; { const self = { s: { x: 1 } }; return self.s; }",
      "box.v.x = 2;",
    ],
    [
      "a nested function's receiver",
      "function other() { const self = this; return self.s; } return other();",
      "box.v.x = 2;",
    ],
    [
      "an alias assigned in a different receiver scope",
      "let self; function assign() { self = this; } assign(); return self.s;",
      "box.v.x = 2;",
    ],
    [
      "an excluded destructuring default",
      "const { value = shared } = { value: { x: 1 } }; return value;",
      "box.v.x = 2;",
    ],
  ])("preserves known values with %s", (_name, getter, write) => {
    expect(returnedValue(getter, write)).toMatchObject({
      status: "literal",
      value: 1,
    });
  });
});

describe("getter receiver alias boundaries", () => {
  it("does not reinterpret an outer this binding as the getter receiver", () => {
    const ir = analyzeJavaScriptSemantics(`export function result() {
      const shared = { x: 1 };
      const outside = this;
      const box = { s: shared, get v() { return outside.s; } };
      box.v.x = 2;
      return shared.x;
    }`);
    expect(onlyCallable(ir, "result").returnSites[0]?.value).toMatchObject({
      status: "literal",
      value: 1,
    });
  });

  it("retains a private field's lexical owner through a receiver alias", () => {
    const ir = analyzeJavaScriptSemantics(`export function result() {
      const shared = { x: 1 };
      class Box {
        #s = shared;
        get v() { const self = this; return self.#s; }
      }
      new Box().v.x = 2;
      return shared.x;
    }`);
    expect(onlyCallable(ir, "result").returnSites[0]?.value.status).toBe(
      "unknown",
    );
  });

  it("does not append a receiver projection to a private field's result path", () => {
    const ir = analyzeJavaScriptSemantics(`export function result() {
      const shared = { x: 1 };
      class Box {
        #s = { peer: shared };
        peer = this;
        get v() { const { peer: self } = this; return self.#s; }
      }
      new Box().v.x = 2;
      return shared.x;
    }`);
    expect(onlyCallable(ir, "result").returnSites[0]?.value).toMatchObject({
      status: "literal",
      value: 1,
    });
  });

  it("resolves a long local alias chain without recursive expansion", () => {
    const aliases = ["const a0 = this;"];
    for (let index = 1; index <= 2000; index++)
      aliases.push(`const a${String(index)} = a${String(index - 1)};`);
    expect(returnedValue(`${aliases.join("\n")} return a2000.s;`)?.status).toBe(
      "unknown",
    );
  });

  it("bounds a growing alias cycle without losing the original receiver", () => {
    expect(
      returnedValue(
        "let self = this; while (flag) self = self.s; return self.s;",
      )?.status,
    ).toBe("unknown");
  });

  it.each([true, false])(
    "retains deeper shared references through an alias cycle (write=%s)",
    (write) => {
      const ir = analyzeJavaScriptSemantics(`export function result() {
        const shared = { x: 1 };
        const box = {
          start: { child: { child: shared } },
          get v() {
            let self = this.start;
            while (flag) self = self.child;
            return self;
          }
        };
        ${write ? "box.v.x = 2;" : "const saved = box.v;"}
        return shared.x;
      }`);
      expect(onlyCallable(ir, "result").returnSites[0]?.value).toMatchObject(
        write ? { status: "unknown" } : { status: "literal", value: 1 },
      );
    },
  );

  it("does not widen a growing cycle to unrelated receiver properties", () => {
    const ir = analyzeJavaScriptSemantics(`export function result() {
      const shared = { x: 1 };
      const unrelated = { x: 1 };
      const box = {
        start: { child: { child: shared } },
        unrelated,
        get v() {
          let self = this.start;
          while (flag) self = self.child;
          return self;
        }
      };
      box.v.x = 2;
      return unrelated.x;
    }`);
    expect(onlyCallable(ir, "result").returnSites[0]?.value).toMatchObject({
      status: "literal",
      value: 1,
    });
  });
});
