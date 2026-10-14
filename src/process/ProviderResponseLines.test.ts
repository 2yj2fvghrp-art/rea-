import { describe, expect, it } from "vitest";

import { ProviderResponseLines } from "./ProviderResponseLines.js";

const reader = (
  maxLineLength: number,
  accept: (line: string) => boolean = () => true,
) => {
  const lines: string[] = [];
  let overflows = 0;
  const responses = new ProviderResponseLines({
    maxLineLength,
    onLine: (line) => {
      lines.push(line);
      return accept(line);
    },
    onOverflow: () => {
      overflows += 1;
    },
  });
  return { responses, lines, overflows: () => overflows };
};

// The production limit is the runtime string length, which a socket test
// cannot reach cheaply; a small limit exercises the same accounting.
describe("ProviderResponseLines", () => {
  it("assembles a line split across chunks when it reaches the limit exactly", () => {
    const { responses, lines, overflows } = reader(8);
    responses.push("abcd");
    responses.push("efgh\n\n  ijk\r\n");

    expect(lines).toEqual(["abcdefgh", "ijk"]);
    expect(overflows()).toBe(0);
  });

  it("reports a terminated line past the limit and drops its prefix", () => {
    const { responses, lines, overflows } = reader(8);
    responses.push("abcd");
    responses.push('efghi\n{"id":2}\n');

    expect(overflows()).toBe(1);
    expect(lines).toEqual([]);

    responses.push("x\n");
    expect(lines).toEqual(["x"]);
  });

  it("reports an unterminated stream before it outgrows the limit", () => {
    const { responses, lines, overflows } = reader(8);
    responses.push("abcdefgh");
    expect(overflows()).toBe(0);

    responses.push("i");
    expect(overflows()).toBe(1);
    responses.push("\n");
    expect(lines).toEqual([]);
  });

  it("drops the rest of a chunk once a line is refused", () => {
    const { responses, lines } = reader(64, (line) => line !== "stop");
    responses.push("first\nstop\nlater\n");

    expect(lines).toEqual(["first", "stop"]);
  });
});
