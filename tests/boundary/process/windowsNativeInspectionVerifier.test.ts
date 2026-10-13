import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertInspectionCleanup,
  inspectionProbeSource,
} from "../../../scripts/verify-windows-native-inspection.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const exec = promisify(execFile);
const verifier = new URL(
  "../../../scripts/verify-windows-native-inspection.mjs",
  import.meta.url,
);

const probe = async (
  mode: "retry" | "teardown",
  cleanup: "identity" | "path",
) => {
  const root = await createTestTempDirectory("rea-inspection-oracle-");
  const temp = join(root, "temp");
  await mkdir(temp);
  const loader = join(root, "loader.mjs");
  // Controlled loader tests only the verifier's ownership oracle. This does
  // not substitute for Windows native handles, sharing, or environment hooks.
  await writeFile(
    loader,
    `import {mkdirSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
const temp=process.env.TEMP;
const original=join(temp,'rea-native-probe-controlled');
let ownedInode;let cached;
const cleanup=()=>{
 if(ownedInode===undefined)return;
 const owned=${JSON.stringify(cleanup)}==='path'?'rea-native-probe-controlled':readdirSync(temp).find(name=>statSync(join(temp,name),{bigint:true}).ino===ownedInode);
 if(owned!==undefined)rmSync(join(temp,owned),{recursive:true,force:true});
 ownedInode=undefined;
};
export const systemWindowsNativeAuthority=()=>{
 if(cached)return cached;
 if(ownedInode!==undefined){cleanup();return cached={available:true};}
 mkdirSync(original);ownedInode=statSync(original,{bigint:true}).ino;
 process.once('exit',cleanup);
 return {available:false,retryable:true,reason:'Delete owned object by handle failed (Win32 5)'};
};
`,
  );
  const script = join(root, "probe.mjs");
  await writeFile(script, inspectionProbeSource(pathToFileURL(loader).href));
  return {
    temp,
    run: () =>
      exec(process.execPath, [script, mode], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, TEMP: temp, TMP: temp },
      }),
  };
};

describe("native inspection verifier ownership oracle (controlled loader)", () => {
  it("does not execute the CLI when the verifier is imported", async () => {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const verifier = await import(${JSON.stringify(verifier.href)}); console.log(typeof verifier.inspectionProbeSource);`,
      ],
      { timeout: 10_000, windowsHide: true },
    );
    expect(stdout.trim()).toBe("function");
    expect(stderr).toBe("");
  });

  // The real Windows lane supplies its native artifact. Non-Windows can prove
  // prerequisite refusal without privileged Windows file-symlink creation.
  it.skipIf(process.platform === "win32").each(["direct", "symlink"] as const)(
    "refuses the real NTFS prerequisite through a %s CLI entrypoint",
    async (entrypoint) => {
      let script = fileURLToPath(verifier);
      if (entrypoint === "symlink") {
        const root = await createTestTempDirectory("rea-inspection-alias-");
        const alias = join(root, "inspection-alias.mjs");
        await symlink(script, alias);
        script = alias;
      }
      await expect(
        exec(process.execPath, [script], {
          timeout: 10_000,
          windowsHide: true,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining(
          "Native inspection ownership requires real Windows NTFS",
        ),
      });
    },
  );

  it.each(["retry", "teardown"] as const)(
    "accepts identity cleanup and preserves the foreign replacement in %s mode",
    async (mode) => {
      const scenario = await probe(mode, "identity");
      const { stdout } = await scenario.run();
      await assertInspectionCleanup(scenario.temp, JSON.parse(stdout));
    },
  );

  it("rejects retry cleanup that follows the former path", async () => {
    const scenario = await probe("retry", "path");
    await expect(scenario.run()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "retry must remove the renamed owned probe and preserve the foreign replacement",
      ),
    });
  });

  it("rejects teardown cleanup that follows the former path after the child exits", async () => {
    const scenario = await probe("teardown", "path");
    const { stdout } = await scenario.run();
    await expect(
      assertInspectionCleanup(scenario.temp, JSON.parse(stdout)),
    ).rejects.toThrow(
      "cleanup must remove the renamed owned probe and preserve the foreign replacement",
    );
  });
});
