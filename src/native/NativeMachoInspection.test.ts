import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { parseMachoLayout, selectMachoSlice } from "./AppleMachoSelection.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { inspectNativeMacho } from "./NativeMachoInspection.js";

const capture = (tool: string, stdout: string): NativeCommandCapture => ({
  tool,
  executable: tool,
  executableSha256: "a".repeat(64),
  toolVersion: null,
  versionReason: null,
  arguments: [],
  stdout,
  stderr: "",
  stdoutBytes: stdout.length,
  stderrBytes: 0,
  exitCode: 0,
  signal: null,
});

const inspect = async (lipo: string, architecture: "x86" | "arm64") => {
  const commands: {
    readonly tool: string;
    readonly args: readonly string[];
  }[] = [];
  const result = await inspectNativeMacho({
    target: {
      kind: "executable",
      format: "mach-o",
      path: "/fixture/app",
      sha256: "b".repeat(64),
      architecture,
      availableArchitectures: ["x86", "arm64"],
    },
    run: (tool, args) => {
      commands.push({ tool, args });
      if (tool === "lipo") return Promise.resolve(ok(capture(tool, lipo)));
      if (tool === "file") return Promise.resolve(ok(capture(tool, "Mach-O")));
      return Promise.resolve(err(new AnalysisCancelledError("inspect_native")));
    },
    invocation: () => {
      throw new Error("invocation is not reached");
    },
  });
  return { result, commands };
};

describe("Mach-O tool architecture selection", () => {
  it("rejects a CPU lipo did not list instead of reading another slice", async () => {
    const { result, commands } = await inspect("architecture arm64\n", "x86");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "lipo did not list i386; refusing to read another slice",
    });
    expect(commands.map(({ tool }) => tool)).toEqual(["file", "lipo"]);
  });

  it("passes the arm64e slice lipo listed for an arm64 target", async () => {
    const { commands } = await inspect("architecture arm64e\n", "arm64");
    const otool = commands.find(({ tool }) => tool === "otool");
    expect(otool?.args).toEqual([
      "-h",
      "-l",
      "-arch",
      "arm64e",
      "/fixture/app",
    ]);
  });

  it.each([
    { names: ["arm64v8", "arm64e"], selected: "arm64e" },
    { names: ["arm64e", "arm64v8"], selected: "arm64e" },
    { names: ["arm64v8", "arm64e", "arm64"], selected: "arm64" },
    { names: ["arm64v8"], selected: "arm64v8" },
    { names: ["arm64v8", "arm64e.x1"], selected: "arm64v8" },
    { names: ["arm64e.x1", "arm64v8"], selected: "arm64v8" },
  ] as const)(
    "keeps inspection and dispatch on $selected for FAT order $names",
    async ({ names, selected }) => {
      const cpus = {
        arm64: CPU.arm64,
        arm64v8: { type: CPU.arm64.type, subtype: 1 },
        arm64e: CPU.arm64e,
        "arm64e.x1": { type: CPU.arm64.type, subtype: 0x8000000c },
      };
      const slices = names.map((name) => {
        const cpu = cpus[name];
        return {
          cpu,
          bytes: machoImage({
            cpu,
            commands: [dylibCommand(LC.LOAD_DYLIB, `/fixture/${name}.dylib`)],
          }),
        };
      });
      const fat = Buffer.from(fatImage(slices));
      const lipo = names
        .map(
          (name, index) =>
            `architecture ${name}\n cputype ${cpus[name].type}\n cpusubtype ${cpus[name].subtype}\n offset ${(index + 1) * 4096}\n size ${slices[index]?.bytes.length}\n align 2^12\n`,
        )
        .join("");
      const { commands } = await inspect(lipo, "arm64");
      expect(commands.find(({ tool }) => tool === "otool")?.args).toEqual([
        "-h",
        "-l",
        "-arch",
        selected,
        "/fixture/app",
      ]);
      expect(selectMachoSlice(fat, "arm64").slice).toBe(
        (names.findIndex((name) => name === selected) + 1) * 4096,
      );
      expect(parseMachoLayout(fat, "arm64").fixups.dylibs).toEqual([
        `/fixture/${selected}.dylib`,
      ]);
    },
  );
});
