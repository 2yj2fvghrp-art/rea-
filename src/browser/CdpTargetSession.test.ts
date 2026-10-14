import { expect, it } from "vitest";

import type { CdpConnection } from "./CdpConnection.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { closeCdpTargetSession } from "./CdpTargetSession.js";

const recordingConnection = (rejected: ReadonlySet<string> = new Set()) => {
  const commands: string[] = [];
  let closed = false;
  const connection = {
    onEvent: () => () => {},
    close: async () => {
      closed = true;
    },
    send: async (method: string, _params?: unknown, sessionId?: string) => {
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

it("disables each enabled domain before detaching and closing", async () => {
  const { connection, commands, isClosed } = recordingConnection();
  await closeCdpTargetSession({ connection, sessionId: "t1" }, [
    "Network",
    "WebMCP",
  ]);
  expect(commands).toEqual([
    "Network.disable@t1",
    "WebMCP.disable@t1",
    "Target.detachFromTarget@-",
  ]);
  expect(isClosed()).toBe(true);
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
  expect(commands).toEqual(["Target.detachFromTarget@-"]);
  expect(isClosed()).toBe(true);
});

it("closes a page-scoped session without a detach", async () => {
  const { connection, commands, isClosed } = recordingConnection();
  await closeCdpTargetSession({ connection, sessionId: undefined }, ["Page"]);
  expect(commands).toEqual(["Page.disable@-"]);
  expect(commands).not.toContain("Target.detachFromTarget@-");
  expect(isClosed()).toBe(true);
});
