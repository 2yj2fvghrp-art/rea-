import { z } from "incur";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>REA UI - Reverse Engineer Anything</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #f4f4f9;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        .form-group {
            margin-bottom: 1.5rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: bold;
        }
        input[type="text"], select {
            width: 100%;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 16px;
        }
        button {
            background-color: #3498db;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            transition: background-color 0.3s;
        }
        button:hover {
            background-color: #2980b9;
        }
        button:disabled {
            background-color: #95a5a6;
            cursor: not-allowed;
        }
        #output-container {
            margin-top: 2rem;
            background-color: #2c3e50;
            color: #ecf0f1;
            padding: 1.5rem;
            border-radius: 4px;
            overflow-x: auto;
            min-height: 200px;
        }
        pre {
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .error {
            color: #e74c3c;
        }
    </style>
</head>
<body>
    <h1>REA UI</h1>
    <p>Select a command and provide the path to analyze.</p>

    <div class="form-group">
        <label for="command">Command:</label>
        <select id="command">
            <option value="analyze">Native Binary Analysis (analyze)</option>
            <option value="analyze-javascript-application">JavaScript/Electron App (analyze-javascript-application)</option>
            <option value="inspect-sqlite-database">SQLite Database (inspect-sqlite-database)</option>
            <option value="inspect-wasm-artifact">WASM Artifact (inspect-wasm-artifact)</option>
            <option value="inspect-android-package">Android APK (inspect-android-package)</option>
            <option value="inspect-evm-interface">EVM Bytecode (inspect-evm-interface)</option>
            <option value="inspect-macho">Mach-O Binary (inspect-macho)</option>
        </select>
    </div>

    <div class="form-group">
        <label for="targetPath">Target Path (Absolute Path):</label>
        <input type="text" id="targetPath" placeholder="/path/to/file/or/directory">
    </div>

    <button id="runBtn" onclick="runAnalysis()">Run Analysis</button>

    <div id="output-container">
        <pre id="output">Results will appear here...</pre>
    </div>

    <script>
        async function runAnalysis() {
            const command = document.getElementById('command').value;
            const targetPath = document.getElementById('targetPath').value;
            const outputEl = document.getElementById('output');
            const runBtn = document.getElementById('runBtn');

            if (!targetPath) {
                alert("Please provide a target path.");
                return;
            }

            runBtn.disabled = true;
            runBtn.innerText = "Running...";
            outputEl.innerHTML = "Analyzing target... This may take a while depending on the target.";
            outputEl.classList.remove("error");

            try {
                const response = await fetch('/api/run', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ command, path: targetPath })
                });

                const data = await response.json();

                if (data.error) {
                    outputEl.innerHTML = data.error + "\\n\\n" + (data.stderr || "");
                    outputEl.classList.add("error");
                } else {
                    outputEl.innerHTML = JSON.stringify(JSON.parse(data.output), null, 2);
                }
            } catch (err) {
                outputEl.innerHTML = "Error: " + err.message;
                outputEl.classList.add("error");
            } finally {
                runBtn.disabled = false;
                runBtn.innerText = "Run Analysis";
            }
        }
    </script>
</body>
</html>`;

export const registerUiCommands = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.ui, {
    description: "Start a simple web user interface for REA",
    options: z.object({
      port: z
        .number()
        .int()
        .positive()
        .default(3000)
        .describe("Port to run the UI server on"),
    }),
    run: ({ options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.ui, async () => {
          return new Promise<void>((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
              if (req.url === "/" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(HTML_CONTENT);
              } else if (req.url === "/api/run" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => {
                  body += chunk.toString();
                });
                req.on("end", async () => {
                  try {
                    const payload = JSON.parse(body);
                    if (!payload.command || !payload.path) {
                      res.writeHead(400, {
                        "Content-Type": "application/json",
                      });
                      res.end(
                        JSON.stringify({ error: "Missing command or path" }),
                      );
                      return;
                    }

                    const rootDir = join(
                      fileURLToPath(import.meta.url),
                      "../../..",
                    );
                    const reaScript = join(rootDir, "scripts", "rea.mjs");
                    const args = [
                      reaScript,
                      payload.command,
                      payload.path,
                      "--json",
                    ];

                    logger.info({ args }, "Executing CLI command from UI");

                    try {
                      const child = spawn(process.execPath, args, {
                        stdio: ["ignore", "pipe", "pipe"],
                      });
                      let stdout = "";
                      let stderr = "";

                      child.stdout.on("data", (chunk) => {
                        stdout += chunk.toString();
                      });
                      child.stderr.on("data", (chunk) => {
                        stderr += chunk.toString();
                      });

                      child.on("close", (code) => {
                        if (code === 0) {
                          res.writeHead(200, {
                            "Content-Type": "application/json",
                          });
                          res.end(
                            JSON.stringify({ output: stdout, stderr: stderr }),
                          );
                        } else {
                          res.writeHead(500, {
                            "Content-Type": "application/json",
                          });
                          res.end(
                            JSON.stringify({
                              error: `Command failed with code ${code}`,
                              stderr: stderr,
                            }),
                          );
                        }
                      });

                      child.on("error", (err) => {
                        res.writeHead(500, {
                          "Content-Type": "application/json",
                        });
                        res.end(
                          JSON.stringify({
                            error: err.message,
                            stderr: stderr,
                          }),
                        );
                      });
                    } catch (execError: any) {
                      res.writeHead(500, {
                        "Content-Type": "application/json",
                      });
                      res.end(
                        JSON.stringify({
                          error: execError.message,
                          stderr: "",
                        }),
                      );
                    }
                  } catch (e: any) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(
                      JSON.stringify({
                        error: "Internal Server Error",
                        details: e.message,
                      }),
                    );
                  }
                });
              } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
              }
            });

            server.on("error", (err) => {
              logger.error(err, "Failed to start UI server");
              reject(err);
            });

            server.listen(options.port, () => {
              logger.info(
                `REA UI server listening on http://localhost:${options.port}`,
              );
              // Provide visual feedback for the user in console
              console.log(`\n\x1b[32m[REA UI]\x1b[0m Started successfully!`);
              console.log(
                `\x1b[32m[REA UI]\x1b[0m Open \x1b[36mhttp://localhost:${options.port}\x1b[0m in your browser.\n`,
              );
            });

            signal.addEventListener("abort", () => {
              logger.info("Shutting down UI server...");
              server.close(() => {
                resolve();
              });
            });
          });
        }),
      ),
  });
};
