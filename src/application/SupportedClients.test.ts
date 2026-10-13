import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import { supportedClients } from "./SupportedClients.js";

const HOME = resolve("/home/test");

const dshClient = (env: Readonly<NodeJS.ProcessEnv>) =>
  supportedClients(HOME, "linux", env).find(({ name }) => name === "dsh");

describe("supportedClients: dsh empty-overwrite handling", () => {
  it("places the dsh patch under $DSH_HOME when set to a real directory", () => {
    const explicit = resolve("/opt/profile");
    const result = dshClient({ DSH_HOME: explicit });

    expect(result?.configPath).toBe(join(explicit, "cordis.patch.yml"));
    expect(result?.markerPath).toBe(explicit);
  });

  it("falls back to ~/.dsh when DSH_HOME is unset", () => {
    const result = dshClient({});

    expect(result?.configPath).toBe(join(HOME, ".dsh", "cordis.patch.yml"));
    expect(result?.markerPath).toBe(join(HOME, ".dsh"));
  });

  // Regression for https://github.com/morluto/rea/issues/2666.
  it("treats an empty DSH_HOME as unset and selects ~/.dsh (issue #2666)", () => {
    const result = dshClient({ DSH_HOME: "" });

    expect(result?.configPath).toBe(join(HOME, ".dsh", "cordis.patch.yml"));
    expect(result?.markerPath).toBe(join(HOME, ".dsh"));
  });

  it("treats a whitespace-only DSH_HOME as unset and selects ~/.dsh", () => {
    const result = dshClient({ DSH_HOME: "   " });

    expect(result?.configPath).toBe(join(HOME, ".dsh", "cordis.patch.yml"));
    expect(result?.markerPath).toBe(join(HOME, ".dsh"));
  });

  it("preserves whitespace in a nonblank DSH_HOME while resolving it", () => {
    const explicit = resolve("/opt/profile");
    const result = dshClient({ DSH_HOME: `  ${explicit}  ` });

    const selected = resolve(`  ${explicit}  `);
    expect(result?.configPath).toBe(join(selected, "cordis.patch.yml"));
    expect(result?.markerPath).toBe(selected);
  });
});
