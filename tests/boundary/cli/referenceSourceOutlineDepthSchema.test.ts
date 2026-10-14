import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

type CliInstance = ReturnType<typeof createCli>;

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

describe("import-reference-source advertised outline-depth schema", () => {
  it("excludes negative outline depths the parser rejects", async () => {
    const cli = createCli({});
    const result = await serve(cli, [
      "import-reference-source",
      "--schema",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout) as {
      readonly options?: {
        readonly properties?: Record<
          string,
          { readonly type?: string; readonly minimum?: number }
        >;
      };
    };
    const outlineDepth = schema.options?.properties?.outlineDepth;
    expect(outlineDepth?.type).toBe("integer");
    // The runtime parser rejects negative depths, so the advertised schema
    // must carry the same minimum instead of the safe-range floor.
    expect(outlineDepth?.minimum).toBe(0);

    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile({
      ...schema.options,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(validate({ outlineDepth: -1 })).toBe(false);
    expect(validate({ outlineDepth: 0 })).toBe(true);
    expect(validate({ outlineDepth: 2 })).toBe(true);
  });
});
