import { expect, it } from "vitest";

import { CLEANUP_DOMAINS } from "./CdpBrowserProvider.js";
import type { CdpConnection } from "./CdpConnection.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { closeCdpTargetSession } from "./CdpTargetSession.js";

const recordingConnection = (rejected: ReadonlySet<string> = new Set()) => {
  const commands: string[] = [];
  let closed = false;
  const connection = {
    onEvent: () => () => {},
    close: () => {
      closed = true;
      commands.push("close");
      return Promise.resolve();
    },
    send: async (method: string, _params?: unknown, sessionId?: string) => {
      if (closed) throw new Error(`send after close: ${method}`);
      commands.push(`${method}@${sessionId ?? "-"}`);
      if (rejected.has(method))
        throw new CdpCommandRejection(
          "inspect_web_page",
          method,
          -32601,
          "Method not found",
        );
      return {};
    },
  } as unknown as CdpConnection;
  return { connection, commands, isClosed: () => closed };
};

it("shuts down every cleanup domain, WebMCP included, before detaching and closing", async () => {
  const { connection, commands } = recordingConnection();
  await closeCdpTargetSession({ connection, sessionId: "t1" }, CLEANUP_DOMAINS);
  // The expectation names every domain explicitly, so removing WebMCP from
  // the production CLEANUP_DOMAINS fails here instead of silently passing.
  expect(commands).toEqual([
    "Network.disable@t1",
    "Debugger.disable@t1",
    "Runtime.disable@t1",
    "Page.disable@t1",
    "WebMCP.disable@t1",
    "Target.detachFromTarget@-",
    "close",
  ]);
});

it("keeps detaching when a domain disable is unsupported", async () => {
  const { connection, commands, isClosed } = recordingConnection(
    new Set(["WebMCP.disable"]),
  );
  await closeCdpTargetSession({ connection, sessionId: "t1" }, [
    "Network",
    "WebMCP",
  ]);
  expect(commands).toEqual([
    "Network.disable@t1",
    "WebMCP.disable@t1",
    "Target.detachFromTarget@-",
    "close",
  ]);
  expect(isClosed()).toBe(true);
});

it("skips domain shutdown for an aborted signal but still detaches", async () => {
  const controller = new AbortController();
  controller.abort();
  const { connection, commands, isClosed } = recordingConnection();
  await closeCdpTargetSession(
    { connection, sessionId: "t1" },
    ["Network"],
    controller.signal,
  );
  expect(commands).toEqual(["Target.detachFromTarget@-", "close"]);
  expect(isClosed()).toBe(true);
});

it("closes a page-scoped session without a detach", async () => {
  const { connection, commands, isClosed } = recordingConnection();
  await closeCdpTargetSession({ connection, sessionId: undefined }, ["Page"]);
  expect(commands).toEqual(["Page.disable@-", "close"]);
  expect(commands).not.toContain("Target.detachFromTarget@-");
  expect(isClosed()).toBe(true);
});
