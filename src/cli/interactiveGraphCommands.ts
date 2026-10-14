import { z } from "incur";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

export const registerInteractiveGraphCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.exportInteractiveGraph, {
    description: "Export an interactive HTML graph from Evidence JSON",
    args: z.object({
      inputJson: z.string().describe("Path to the input JSON evidence file"),
      outputHtml: z.string().describe("Path to the output HTML file"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.exportInteractiveGraph, async () => {
        try {
          const inputPath = resolve(process.cwd(), args.inputJson);
          const outputPath = resolve(process.cwd(), args.outputHtml);
          const rawJson = await readFile(inputPath, "utf8");
          const jsonData = JSON.parse(rawJson);

          // Escape HTML script tags to prevent XSS / broken script tags
          const escapedJsonStr = JSON.stringify(jsonData).replace(
            /</g,
            "\\u003c",
          );

          const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>REA Interactive Graph</title>
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style type="text/css">
        #mynetwork {
            width: 100vw;
            height: 100vh;
            border: 1px solid lightgray;
        }
        body { margin: 0; padding: 0; overflow: hidden; }
    </style>
</head>
<body>
<div id="mynetwork"></div>
<script type="text/javascript">
    const evidenceData = ${escapedJsonStr};

    // Attempt to extract nodes and edges in a generic way or from common graph structures
    let nodesArray = [];
    let edgesArray = [];

    if (evidenceData && evidenceData.result && evidenceData.result.graph) {
       const g = evidenceData.result.graph;
       if (Array.isArray(g.nodes)) {
           nodesArray = g.nodes.map(n => ({ id: n.id, label: n.label || n.id }));
       }
       if (Array.isArray(g.edges)) {
           edgesArray = g.edges.map(e => ({ from: e.source || e.from, to: e.target || e.to, label: e.label || '' }));
       }
    } else if (evidenceData && Array.isArray(evidenceData.modules)) {
       // Support for JS module structures
       nodesArray = evidenceData.modules.map((m, i) => ({ id: m.id || String(i), label: m.name || m.id || String(i) }));
       // Basic dummy edges
    } else {
       nodesArray = [{ id: '1', label: 'No standard graph data found' }];
    }

    const nodes = new vis.DataSet(nodesArray);
    const edges = new vis.DataSet(edgesArray);
    const container = document.getElementById('mynetwork');
    const data = { nodes: nodes, edges: edges };
    const options = {
      nodes: { shape: 'box' },
      physics: { stabilization: false }
    };
    const network = new vis.Network(container, data, options);
</script>
</body>
</html>
          `;
          await writeFile(outputPath, htmlContent, "utf8");
          return { ok: true, value: { success: true, file: outputPath } };
        } catch (error) {
          return {
            error: "Failed to export interactive graph",
            ...projectAnalysisError(
              new AnalysisInputError(CLI_COMMANDS.exportInteractiveGraph, {
                cause: error,
              }),
            ),
          };
        }
      }),
  });
};
