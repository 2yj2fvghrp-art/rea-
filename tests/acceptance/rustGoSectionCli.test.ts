import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { createRustElfWithGoSection } from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "isolates Rust dependency inspection from Go section admission through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-rust-go-section-");
    const bytes = createRustElfWithGoSection();
    const control = Buffer.from(bytes);
    const namesSize = Number(bytes.readBigUInt64LE(320 + 32));
    control.write(
      ".extra\0",
      768 + namesSize - Buffer.byteLength(".go.buildinfo\0"),
    );
    const mcp = surface === "stdio MCP" ? await connectLocalToolsMcp() : null;
    const inspect = async (path: string, language: "rust" | "go") => {
      if (mcp !== null) {
        const response = await mcp.call(
          language === "rust" ? "inspect_rust_binary" : "inspect_go_binary",
          { path },
        );
        return {
          success: response.isError !== true,
          document: response.structuredContent ?? response.content,
        };
      }
      const response = await cli.run({
        arguments: [
          language === "rust" ? "inspect-rust-binary" : "inspect-go-binary",
          path,
          "--json",
        ],
      });
      return { success: response.exitCode === 0, document: response.json };
    };
    let metadata: unknown;
    for (const [name, content] of [
      ["extra", control],
      ["go", bytes],
    ] as const) {
      const path = join(root, name + ".elf");
      await writeFile(path, content);
      const response = await inspect(path, "rust");
      expect(response.success, JSON.stringify(response.document)).toBe(true);
      const report = toolContract("inspect_rust_binary").outputSchema.parse(
        response.document,
      ).normalized_result;
      expect(report.artifact).toEqual({
        path,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      expect(report.auditable_metadata).toMatchObject({
        root_package_index: 1,
        packages: [{ name: "itoa" }, { name: "sample", root: true }],
        dependency_edges: [{ from_index: 1, to_index: 0 }],
      });
      if (name === "extra") metadata = report.auditable_metadata;
      else expect(report.auditable_metadata).toEqual(metadata);
    }
    const go = await inspect(join(root, "go.elf"), "go");
    expect(go.success).toBe(false);
    expect(JSON.stringify(go.document)).toContain("invalid_request");
    const brokenTable = Buffer.from(bytes);
    brokenTable.writeBigUInt64LE(BigInt(bytes.length + 64), 40);
    const brokenDependency = Buffer.from(bytes);
    brokenDependency.fill(0, 1024, 1040);
    for (const [name, content] of [
      ["table", brokenTable],
      ["dependency", brokenDependency],
    ] as const) {
      const path = join(root, name + ".elf");
      await writeFile(path, content);
      const response = await inspect(path, "rust");
      expect(response.success).toBe(false);
      expect(JSON.stringify(response.document)).toContain("invalid_request");
    }
  },
);
