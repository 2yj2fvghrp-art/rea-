import { describe, expect, it } from "vitest";

import {
  classifyPackageImportSpecifier,
  classifyPackageImportTargetString,
  lookupExactPackageImport,
} from "./javascriptPackageImportAliases.js";

describe("package import specifier classification", () => {
  it("treats an exact hash alias as an exact key", () => {
    expect(classifyPackageImportSpecifier("#config")).toEqual({
      kind: "exact",
      key: "#config",
    });
  });

  it.each(["#internal/env", "#/hidden"])(
    "treats %j as an exact key",
    (specifier) => {
      expect(classifyPackageImportSpecifier(specifier)).toEqual({
        kind: "exact",
        key: specifier,
      });
    },
  );

  it.each(["#", "#/", "#utils/"])(
    "rejects reserved specifier %j",
    (specifier) => {
      expect(classifyPackageImportSpecifier(specifier)).toEqual({
        kind: "invalid",
      });
    },
  );

  it.each(["#internal/*", "#*"])(
    "rejects literal pattern specifier %j",
    (specifier) => {
      expect(classifyPackageImportSpecifier(specifier)).toEqual({
        kind: "invalid",
      });
    },
  );
});

describe("exact package import lookup", () => {
  it("returns the exact target without falling through to another key", () => {
    expect(
      lookupExactPackageImport(
        { "#config": "./config.cjs", "#other": "./other.cjs" },
        "#config",
      ),
    ).toEqual({
      kind: "found",
      target: "./config.cjs",
      declared: ["#config", "#other"],
    });
  });

  it("names declared exact keys when the requested alias is absent", () => {
    expect(
      lookupExactPackageImport({ "#config": "./config.cjs" }, "#missing"),
    ).toEqual({
      kind: "missing-key",
      declared: ["#config"],
    });
  });

  it("selects a matching single-wildcard key", () => {
    expect(
      lookupExactPackageImport({ "#internal/*": "./src/*.js" }, "#internal/a"),
    ).toEqual({
      kind: "found",
      target: "./src/*.js",
      declared: ["#internal/*"],
      capture: "a",
    });
  });

  it("still selects an exact key when the same map also has patterns", () => {
    expect(
      lookupExactPackageImport(
        { "#config": "./config.cjs", "#internal/*": "./src/*.js" },
        "#config",
      ),
    ).toEqual({
      kind: "found",
      target: "./config.cjs",
      declared: ["#config", "#internal/*"],
    });
  });

  it.each([undefined, null, "./config.cjs", ["#config"], 7] as const)(
    "treats non-object imports value %j as an undefined map",
    (imports) => {
      expect(lookupExactPackageImport(imports, "#config")).toEqual({
        kind: "undefined-map",
      });
    },
  );

  it("does not treat a pattern key as an exact match for itself", () => {
    expect(
      lookupExactPackageImport({ "#internal/*": "./src/*.js" }, "#internal/*"),
    ).toEqual({
      kind: "pattern-unresolved",
      declared: ["#internal/*"],
    });
  });

  it("prefers the longest pattern prefix, then suffix", () => {
    expect(
      lookupExactPackageImport(
        {
          "#internal/*": "./fallback/*.js",
          "#internal/utils/*": "./utils/*.js",
          "#internal/*/detail": "./details/*.js",
        },
        "#internal/utils/detail",
      ),
    ).toMatchObject({
      kind: "found",
      target: "./utils/*.js",
      capture: "detail",
    });
  });
});

describe("package import target string classification", () => {
  it("keeps package-local relative targets", () => {
    expect(classifyPackageImportTargetString("./config.cjs")).toEqual({
      kind: "relative",
      target: "./config.cjs",
    });
  });

  it("marks recursive hash aliases as recursive", () => {
    expect(classifyPackageImportTargetString("#other")).toEqual({
      kind: "recursive",
      target: "#other",
    });
  });

  it.each(["lodash", "pkg/subpath"])(
    "marks %j as an external-package target",
    (target) => {
      expect(classifyPackageImportTargetString(target)).toEqual({
        kind: "external-package",
        target,
      });
    },
  );

  it.each([
    "../outside.js",
    "/outside.js",
    "https://example.invalid/mod.js",
    "file:///outside.js",
    "node:fs",
  ])("marks %j as an invalid import target", (target) => {
    expect(classifyPackageImportTargetString(target)).toEqual({
      kind: "invalid",
      target,
    });
  });
});
