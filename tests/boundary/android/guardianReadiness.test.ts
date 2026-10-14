import { PassThrough } from "node:stream";

import { expect, it } from "vitest";
import { readGuardianReadyLine } from "../../../src/android/JadxWorkspaceRoot.js";

it("preserves a Windows parent path when UTF-8 bytes cross stdout chunks", async () => {
  const stdout = new PassThrough();
  const line = JSON.stringify({
    path: "C:\\Users\\测试\\rea-android-0123456789abcdef0123456789abcdef",
  });
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const split = bytes.indexOf(Buffer.from("测", "utf8")) + 1;
  const ready = readGuardianReadyLine(stdout);

  stdout.write(bytes.subarray(0, split));
  stdout.write(bytes.subarray(split));

  await expect(ready).resolves.toBe(line);
  expect(stdout.listenerCount("data")).toBe(0);
});

it("bounds guardian readiness by UTF-8 bytes", async () => {
  const stdout = new PassThrough();
  const ready = readGuardianReadyLine(stdout);

  stdout.write(`${"测".repeat(1400)}\n`);

  await expect(ready).rejects.toThrow("exceeded 4 KiB");
  expect(stdout.listenerCount("data")).toBe(0);
});

it("rejects invalid UTF-8 before accepting a guardian path", async () => {
  const stdout = new PassThrough();
  const ready = readGuardianReadyLine(stdout);

  stdout.write(Buffer.from([0xff, 0x0a]));

  await expect(ready).rejects.toThrow();
  expect(stdout.listenerCount("data")).toBe(0);
});
