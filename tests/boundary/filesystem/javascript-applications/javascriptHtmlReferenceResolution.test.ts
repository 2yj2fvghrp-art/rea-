import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../support/javascriptApplicationScope.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it("resolves empty-path HTML script URLs against their canonical base path", async () => {
  const root = await createTestTempDirectory("rea-html-empty-reference-");
  await Promise.all([
    mkdir(join(root, "base-file", "assets"), { recursive: true }),
    mkdir(join(root, "base-directory", "assets"), { recursive: true }),
    mkdir(join(root, "escaped"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "document.html"),
      '<script src="?document=1"></script><script src="#document-fragment"></script>',
    ),
    writeFile(
      join(root, "base-file", "index.html"),
      '<base href="assets/entry.html?base=1#base-fragment"><script src="?base-file=1#script-fragment"></script>',
    ),
    writeFile(join(root, "base-file", "assets", "entry.html"), "<main></main>"),
    writeFile(
      join(root, "base-directory", "index.html"),
      '<base href="assets/"><script src="?base-directory=1"></script>',
    ),
    writeFile(
      join(root, "base-directory", "assets", "index.js"),
      "export const value = 1;",
    ),
    writeFile(
      join(root, "escaped", "index.html"),
      '<base href="../../outside/"><script src="?escape=1"></script>',
    ),
  ]);

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    format: "directory",
  });
  const graph = result.graph;
  const loadFor = (scriptPath: string) =>
    graph.edges.find(
      (edge) =>
        edge.relation === "loads" && edge.properties.script_path === scriptPath,
    );
  const targetPath = (edge: NonNullable<ReturnType<typeof loadFor>>) =>
    graph.nodes
      .find(({ node_id }) => node_id === edge.target_node_id)
      ?.observations.find(
        ({ properties }) => typeof properties.path === "string",
      )?.properties.path;
  const unresolvedReference = (scriptPath: string) =>
    graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties }) =>
          properties.mechanism === "html-script-reference" &&
          properties.script_path === scriptPath,
      )?.properties;

  for (const scriptPath of ["?document=1", "#document-fragment"]) {
    const edge = loadFor(scriptPath);
    expect(edge).toMatchObject({
      properties: {
        script_path: scriptPath,
        resolved_path: "document.html",
        resolution_status: "resolved",
      },
    });
    if (edge !== undefined) expect(targetPath(edge)).toBe("document.html");
  }

  const baseFileEdge = loadFor("?base-file=1#script-fragment");
  expect(baseFileEdge).toMatchObject({
    properties: {
      script_path: "?base-file=1#script-fragment",
      base_href: "assets/entry.html?base=1#base-fragment",
      resolved_path: "base-file/assets/entry.html",
      resolution_status: "resolved",
    },
  });
  if (baseFileEdge !== undefined)
    expect(targetPath(baseFileEdge)).toBe("base-file/assets/entry.html");

  expect(unresolvedReference("?base-directory=1")).toMatchObject({
    resolution_status: "not-found",
    limitations: [expect.stringContaining("resolves to directory")],
  });
  expect(unresolvedReference("?escape=1")).toMatchObject({
    resolution_status: "rejected",
    limitations: [
      expect.stringContaining("escapes the canonical artifact root"),
    ],
  });
});

it("retains directory-form HTML script URLs without loading a file with their collapsed name", async () => {
  const root = await createTestTempDirectory("rea-html-directory-reference-");
  await mkdir(join(root, "renderer", "child"), { recursive: true });
  const directoryReferences = [
    "local.js/?directory=1#fragment",
    "local.js/.",
    "./child/..",
    "..",
  ];
  const ordinaryReference = "local.js?control=1#fragment";
  await Promise.all([
    writeFile(
      join(root, "renderer", "index.html"),
      [...directoryReferences, ordinaryReference]
        .map((scriptPath) => `<script src="${scriptPath}"></script>`)
        .join(""),
    ),
    writeFile(join(root, "renderer", "local.js"), "export const decoy = true;"),
  ]);

  const { graph } = await reconstructJavaScriptArtifact({
    input_path: root,
    format: "directory",
  });
  const loads = graph.edges.filter(({ relation }) => relation === "loads");
  const unresolved = graph.nodes.flatMap(({ observations }) => observations);
  for (const scriptPath of directoryReferences) {
    expect(
      loads.some(({ properties }) => properties.script_path === scriptPath),
    ).toBe(false);
    expect(
      unresolved.find(
        ({ properties }) =>
          properties.mechanism === "html-script-reference" &&
          properties.script_path === scriptPath,
      ),
    ).toMatchObject({
      properties: {
        script_path: scriptPath,
        base_href: null,
        declared_path: scriptPath,
        resolution_context: "html-reference",
        resolved_path: null,
        resolution_status: "not-found",
        limitations: [expect.stringContaining("resolves to directory")],
      },
      evidence: {
        limitations: expect.arrayContaining([
          expect.stringContaining("resolves to directory"),
        ]),
      },
    });
  }
  const ordinaryLoad = loads.find(
    ({ properties }) => properties.script_path === ordinaryReference,
  );
  expect(loads.map(({ properties }) => properties.script_path)).toEqual([
    ordinaryReference,
  ]);
  expect(ordinaryLoad).toMatchObject({
    properties: {
      script_path: ordinaryReference,
      base_href: null,
      resolved_path: "renderer/local.js",
      resolution_status: "resolved",
    },
  });
  expect(
    graph.nodes
      .find(({ node_id }) => node_id === ordinaryLoad?.target_node_id)
      ?.observations.find(
        ({ properties }) => properties.path === "renderer/local.js",
      ),
  ).toBeDefined();
});

it("retains empty HTML URL path segments in declarations and bases without loading collapsed files", async () => {
  const root = await createTestTempDirectory(
    "rea-html-empty-segment-reference-",
  );
  await Promise.all([
    mkdir(join(root, "declared", "assets"), { recursive: true }),
    mkdir(join(root, "base", "assets"), { recursive: true }),
    mkdir(join(root, "ordinary", "assets"), { recursive: true }),
  ]);
  const references = [
    {
      htmlPath: "declared/index.html",
      scriptPath: "assets//app.js?declared=1#fragment",
      baseHref: null,
    },
    {
      htmlPath: "base/index.html",
      scriptPath: "app.js?base=1#fragment",
      baseHref: "assets//",
    },
  ];
  await Promise.all([
    ...references.map(({ htmlPath, scriptPath, baseHref }) =>
      writeFile(
        join(root, htmlPath),
        `${baseHref === null ? "" : `<base href="${baseHref}">`}<script src="${scriptPath}"></script>`,
      ),
    ),
    writeFile(
      join(root, "ordinary", "index.html"),
      '<base href="assets/"><script src="app.js?control=1#fragment"></script>',
    ),
    ...["declared", "base", "ordinary"].map((directory) =>
      writeFile(
        join(root, directory, "assets", "app.js"),
        "export const value = 1;",
      ),
    ),
  ]);

  const { graph } = await reconstructJavaScriptArtifact({
    input_path: root,
    format: "directory",
  });
  const loads = graph.edges.filter(({ relation }) => relation === "loads");
  const observations = graph.nodes.flatMap(
    ({ observations: retained }) => retained,
  );
  for (const { scriptPath, baseHref } of references) {
    expect(
      loads.some(({ properties }) => properties.script_path === scriptPath),
    ).toBe(false);
    expect(
      observations.find(
        ({ properties }) =>
          properties.mechanism === "html-script-reference" &&
          properties.script_path === scriptPath,
      ),
    ).toMatchObject({
      properties: {
        script_path: scriptPath,
        base_href: baseHref,
        declared_path: scriptPath,
        resolution_context: "html-reference",
        resolved_path: null,
        resolution_status: "unavailable",
        limitations: [expect.stringContaining("Repeated URL path separators")],
      },
      evidence: {
        limitations: expect.arrayContaining([
          expect.stringContaining("Repeated URL path separators"),
        ]),
      },
    });
  }
  const ordinaryLoad = loads.find(
    ({ properties }) => properties.script_path === "app.js?control=1#fragment",
  );
  expect(loads.map(({ properties }) => properties.script_path)).toEqual([
    "app.js?control=1#fragment",
  ]);
  expect(ordinaryLoad).toMatchObject({
    properties: {
      script_path: "app.js?control=1#fragment",
      base_href: "assets/",
      resolved_path: "ordinary/assets/app.js",
      resolution_status: "resolved",
    },
  });
  expect(
    graph.nodes
      .find(({ node_id }) => node_id === ordinaryLoad?.target_node_id)
      ?.observations.find(
        ({ properties }) => properties.path === "ordinary/assets/app.js",
      ),
  ).toBeDefined();
});
