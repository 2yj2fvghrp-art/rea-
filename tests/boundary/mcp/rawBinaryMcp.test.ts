import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { silentLogger } from "../../../src/logger.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

const connect = async () => {
  const session = createTestBinarySession(createCacheProvider([]));
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const client = new Client({ name: "raw-binary-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

it("opens a headerless image when architecture and entry are supplied", async () => {
  const root = await createTestTempDirectory("rea-raw-mcp-");
  const path = join(root, "ecu.bin");
  await writeFile(path, Buffer.from("1eff2fe1", "hex"));
  const { client } = await connect();
  const opened = await client.callTool({
    name: "open_binary",
    arguments: {
      path,
      format: "raw-binary",
      architecture: "arm",
      entry_point: "0x08000000",
    },
  });
  expect(opened.isError).not.toBe(true);
  expect(structured(opened).result).toMatchObject({
    path,
    format: "raw-binary",
    kind: "executable",
    architecture: "arm",
  });
});

it("rejects raw-binary open requests that omit architecture", async () => {
  const root = await createTestTempDirectory("rea-raw-mcp-missing-");
  const path = join(root, "ecu.bin");
  await writeFile(path, Buffer.from("1eff2fe1", "hex"));
  const { client } = await connect();
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path, format: "raw-binary" },
  });
  expect(opened.isError).toBe(true);
});
