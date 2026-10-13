#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "research-ui",
);
const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/case.js", ["case.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

/** Serve only the local research UI assets on a loopback address. */
export const createResearchUiServer = () =>
  createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const route = routes.get(request.url ?? "");
    if (route === undefined) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(uiRoot, route[0]));
      response.writeHead(200, { "Content-Type": route[1] });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (cause) {
      process.stderr.write(
        `Research UI asset could not be read: ${String(cause)}\n`,
      );
      response.writeHead(500).end();
    }
  });

/** Start the source-owned browser intake without starting REA analysis. */
export const startResearchUi = async () => {
  const server = createResearchUiServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Research UI address unavailable after listen");
  process.stdout.write(
    `REA research case UI: http://127.0.0.1:${String(address.port)}/\n`,
  );
  process.stdout.write(
    "This server serves only local UI files. Press Ctrl-C to stop it.\n",
  );
  return server;
};

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath)
  await startResearchUi();
