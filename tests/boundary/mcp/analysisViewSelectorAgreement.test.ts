import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

interface SelectorCase {
  readonly label: string;
  readonly view: unknown;
  readonly admitted: boolean;
}

const retainedEvidenceId = `ev_${"a".repeat(64)}`;
const moduleNodeId = `jag_node_${"b".repeat(64)}`;

/**
 * The advertised input schema and the server's input validation must agree on
 * which collection/selector pairings exist. Before this agreement the published
 * schema accepted `modules` with `index` and `sections` with `node_id`, so a
 * client that validated against it sent arguments the server then rejected as
 * invalid. A pairing is admitted when the call gets past argument validation;
 * reaching Evidence resolution and failing there still proves admission, which
 * is why the assertion keys on the validation failure rather than on success.
 */
const selectorCases: readonly SelectorCase[] = [
  {
    label: "modules + path",
    view: { kind: "item", collection: "modules", selector: { path: "a.js" } },
    admitted: true,
  },
  {
    label: "modules + empty path",
    view: { kind: "item", collection: "modules", selector: { path: "" } },
    admitted: true,
  },
  {
    label: "modules + node_id",
    view: {
      kind: "item",
      collection: "modules",
      selector: { node_id: moduleNodeId },
    },
    admitted: true,
  },
  {
    label: "modules + index",
    view: { kind: "item", collection: "modules", selector: { index: 0 } },
    admitted: false,
  },
  {
    label: "modules + name",
    view: { kind: "item", collection: "modules", selector: { name: "a.js" } },
    admitted: false,
  },
  {
    label: "sections + index",
    view: { kind: "item", collection: "sections", selector: { index: 0 } },
    admitted: true,
  },
  {
    label: "sections + name",
    view: { kind: "item", collection: "sections", selector: { name: ".data" } },
    admitted: true,
  },
  {
    label: "sections + path",
    view: { kind: "item", collection: "sections", selector: { path: "a.js" } },
    admitted: false,
  },
  {
    label: "sections + node_id",
    view: {
      kind: "item",
      collection: "sections",
      selector: { node_id: moduleNodeId },
    },
    admitted: false,
  },
  {
    label: "symbols + index",
    view: { kind: "item", collection: "symbols", selector: { index: 1 } },
    admitted: true,
  },
  {
    label: "symbols + name",
    view: { kind: "item", collection: "symbols", selector: { name: "main" } },
    admitted: true,
  },
  {
    label: "symbols + node_id",
    view: {
      kind: "item",
      collection: "symbols",
      selector: { node_id: moduleNodeId },
    },
    admitted: false,
  },
];

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "selector-agreement", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
};

/**
 * The SDK rejects arguments against the advertised schema before the request is
 * sent, and the server rejects them during input validation. Either way the
 * pairing is not admitted, and both paths report an input-validation failure
 * rather than an analysis outcome.
 */
const wasRejectedAsInvalidInput = async (
  client: Client,
  view: unknown,
): Promise<boolean> => {
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: retainedEvidenceId },
      view,
    },
  });
  if (response.isError !== true) return false;
  const text =
    (response.content as { type: string; text?: string }[]).find(
      (entry) => entry.type === "text",
    )?.text ?? "";
  return /input validation|invalid arguments|invalid_request/i.test(text);
};

it("advertises exactly the collection/selector pairings the server admits", async () => {
  const { client } = await connect();
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (advertised === undefined)
    throw new Error("inspect_analysis_view was not registered");

  for (const entry of selectorCases) {
    const rejected = await wasRejectedAsInvalidInput(client, entry.view);
    expect(
      rejected,
      entry.admitted
        ? `${entry.label} is advertised but rejected as invalid input`
        : `${entry.label} is rejected at runtime but the advertised schema admits it`,
    ).toBe(!entry.admitted);
  }
});
