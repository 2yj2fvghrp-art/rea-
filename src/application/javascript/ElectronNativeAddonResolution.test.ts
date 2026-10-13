import { expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";
import { resolveElectronNativeAddon } from "./ElectronBoundaryAnalysis.js";

const file = (
  path: string,
  kind: JavaScriptArtifactFile["kind"],
): JavaScriptArtifactFile => ({
  path,
  container_sha256: "0".repeat(64),
  sha256: "0".repeat(64),
  bytes: 0,
  inventory_artifact_id: path,
  kind,
  unpacked: false,
  text: { included: false, reason: "not-applicable" },
});

const resolve = (argument: string) => {
  const source = file("pkg/index.js", "javascript");
  const files = new Map(
    [
      source,
      file("pkg/package.json", "package-json"),
      file("pkg/build/Release/caller.node", "native-addon"),
      file("pkg/plugin/build/Release/plugin.node", "native-addon"),
    ].map((entry) => [entry.path, entry]),
  );
  const [finding] = analyzeJavaScriptStaticSource(
    `const load=require("node-gyp-build");module.exports=load(${argument});`,
  ).electron.native_addon_bindings;
  if (finding === undefined) throw new Error("Expected a loader finding");
  return resolveElectronNativeAddon(source, finding, files);
};

it("searches the directory node-gyp-build receives", () => {
  expect(resolve("__dirname")).toMatchObject({
    resolved_path: "pkg/build/Release/caller.node",
    candidates: ["pkg/build/Release/caller.node"],
  });
  expect(resolve('require("path").join(__dirname,"plugin")')).toMatchObject({
    resolved_path: "pkg/plugin/build/Release/plugin.node",
    candidates: ["pkg/plugin/build/Release/plugin.node"],
  });
  for (const unknown of ['"plugin"', "options.root"])
    expect(resolve(unknown)).toMatchObject({
      resolved_path: null,
      candidates: [],
    });
});
