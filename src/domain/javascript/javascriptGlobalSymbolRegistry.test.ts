import { expect, it } from "vitest";

import { globalSymbolRegistryCompanions } from "./javascriptGlobalSymbolRegistry.js";

it("charges each companion once when sources share several candidate keys", () => {
  const core = {
    path: "core.js",
    text: 'require("electron");globalThis[Symbol.for("demo.modules")]=[];',
  };
  const app = {
    path: "app.js",
    text: `require("electron");const modules=globalThis[Symbol.for("demo.modules")];${" ".repeat(200)}`,
  };
  const budget = Buffer.byteLength(core.text) + Buffer.byteLength(app.text);
  const { companions, limitations } = globalSymbolRegistryCompanions(
    [core, app],
    budget,
  );
  expect(limitations).toEqual([]);
  expect(companions.get("core.js")).toEqual([app]);
  expect(companions.get("app.js")).toEqual([core]);
});
