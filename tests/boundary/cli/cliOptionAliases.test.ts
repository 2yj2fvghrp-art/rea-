import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const serve = async (
  cli: CliInstance,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

// Incur's extractBuiltinFlags consumes these tokens anywhere in argv before
// command options are parsed, so a command option with the same spelling
// could never receive them.
const INCUR_BUILTIN_FLAGS = new Set([
  "--filter-output",
  "--format",
  "--full-output",
  "--help",
  "--json",
  "--llms",
  "--llms-full",
  "--mcp",
  "--schema",
  "--token-count",
  "--token-limit",
  "--token-offset",
  "--update",
  "--version",
]);

const registeredLongOptions = (cli: CliInstance, command: string): string[] => {
  const entry = registeredCommands.get(cli)?.get(command);
  const options: unknown =
    entry === undefined ? undefined : Reflect.get(entry, "options");
  const shape: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "shape")
      : undefined;
  return typeof shape === "object" && shape !== null
    ? Object.keys(shape).map(
        (key) =>
          `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      )
    : [];
};

const registeredAliases = (
  cli: CliInstance,
  command: string,
): Record<string, unknown> => {
  const entry = registeredCommands.get(cli)?.get(command);
  const alias: unknown =
    entry === undefined ? undefined : Reflect.get(entry, "alias");
  return typeof alias === "object" && alias !== null ? { ...alias } : {};
};

describe("CLI option aliases", () => {
  it("register only single-character short flags", async () => {
    const cli = createCli({});
    const invalid: string[] = [];
    const undescribed: string[] = [];
    for (const command of createCliInventory(cli).primary) {
      for (const [option, short] of Object.entries(
        registeredAliases(cli, command),
      ))
        if (typeof short !== "string" || short.length !== 1)
          invalid.push(`${command} ${option}: ${String(short)}`);
      // Incur parses `-abc` as stacked one-letter flags, so help must never
      // advertise a multi-letter single-dash spelling.
      const help = await serve(cli, [command, "--help"]);
      for (const match of help.stdout.matchAll(/(?:^|[\s,])-([a-z][\w-]+)/gmu))
        invalid.push(`${command} help: -${match[1] ?? ""}`);
      const options = /^Options:\n((?: {2}.*\n?)*)/mu.exec(help.stdout)?.[1];
      for (const line of options?.split("\n") ?? [])
        if (/^ {2}--\S+(?: <[^>]+>)?\s*$/u.test(line))
          undescribed.push(`${command} ${line.trim()}`);
    }
    expect(invalid).toEqual([]);
    expect(undescribed).toEqual([]);
  });

  it("register no long options that Incur reserves as builtin flags", () => {
    const cli = createCli({});
    const commands = createCliInventory(cli).primary;
    const shadowed = commands.flatMap((command) =>
      registeredLongOptions(cli, command)
        .filter((option) => INCUR_BUILTIN_FLAGS.has(option))
        .map((option) => `${command} ${option}`),
    );
    expect(
      commands.some(
        (command) => registeredLongOptions(cli, command).length > 0,
      ),
    ).toBe(true);
    expect(shadowed).toEqual([]);
  });

  it("accepts kebab-case long options without registered aliases", async () => {
    const cli = createCli({});
    const result = await serve(cli, [
      "inspect-plist",
      "/nonexistent/REA.app",
      "--relative-path",
      "Contents/Info.plist",
      "--json",
    ]);
    expect(result.stdout).not.toContain("Unknown flag");
    expect(result.stdout).toContain("/nonexistent/REA.app");
  });
});
