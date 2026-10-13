import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sentinelName = "unrelated-sentinel.txt";
const sentinelText = "Foreign replacement must survive native probe cleanup.\n";

/** One source producer for the real Windows probe and controlled oracle tests. */
export const inspectionProbeSource = (
  loader,
) => `import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {systemWindowsNativeAuthority} from ${JSON.stringify(loader)};
const temp=process.env.TEMP;
const first=systemWindowsNativeAuthority();
assert.equal(first.available,false);
assert.equal(first.retryable,true);
assert.match(first.reason,/Delete owned object by handle failed.*Win32 5/s);
const [name,...extra]=readdirSync(temp);assert.ok(name);assert.equal(extra.length,0);
const path=join(temp,name);const identity=statSync(path,{bigint:true});
const moved=path+'-replacement';
renameSync(path,moved);
assert.equal(statSync(moved,{bigint:true}).ino,identity.ino);
mkdirSync(path);
writeFileSync(join(path,${JSON.stringify(sentinelName)}),${JSON.stringify(sentinelText)},{flag:'wx'});
const foreignIdentity=statSync(path,{bigint:true});
assert.notEqual(foreignIdentity.ino,identity.ino);
if(process.argv[2]!=='teardown'){
 const second=systemWindowsNativeAuthority();assert.equal(second.available,true);
 assert.deepEqual(readdirSync(temp),[name],'retry must remove the renamed owned probe and preserve the foreign replacement');
 assert.equal(statSync(path,{bigint:true}).ino,foreignIdentity.ino);
 assert.equal(readFileSync(join(path,${JSON.stringify(sentinelName)}),'utf8'),${JSON.stringify(sentinelText)});
 assert.equal(systemWindowsNativeAuthority(),second);
}
console.log(JSON.stringify({mode:process.argv[2],firstFailed:true,retainedOwner:true,probeName:name,ownedInode:identity.ino.toString(),foreignInode:foreignIdentity.ino.toString()}));
`;

/** Runs after child environment teardown, before the fixture's outer cleanup. */
export const assertInspectionCleanup = async (temp, observed) => {
  assert.equal(observed.firstFailed, true);
  assert.equal(observed.retainedOwner, true);
  assert.deepEqual(
    await readdir(temp),
    [observed.probeName],
    "cleanup must remove the renamed owned probe and preserve the foreign replacement",
  );
  const foreign = join(temp, observed.probeName);
  assert.equal(
    (await stat(foreign, { bigint: true })).ino.toString(),
    observed.foreignInode,
  );
  assert.equal(
    await readFile(join(foreign, sentinelName), "utf8"),
    sentinelText,
  );
};

const main = async () => {
  if (process.platform !== "win32")
    throw new Error("Native inspection ownership requires real Windows NTFS");
  const root = resolve(process.argv[2] ?? ".");
  const artifact = resolve(
    process.argv[3] ?? ".cache/windows-native-inspection-fixture",
  );
  const workspace = await mkdtemp(
    join(tmpdir(), "rea-inspection-conformance-"),
  );
  try {
    // Isolate the fixture from the packaged production artifact and loader cache.
    await mkdir(join(workspace, "dist", "windows"), { recursive: true });
    await mkdir(join(workspace, "native", "windows", "build"), {
      recursive: true,
    });
    await writeFile(join(workspace, "package.json"), '{"type":"module"}');
    await copyFile(
      join(root, "dist", "windows", "WindowsNativeLoader.js"),
      join(workspace, "dist", "windows", "WindowsNativeLoader.js"),
    );
    await copyFile(
      join(root, "dist", "generatedPackageMetadata.js"),
      join(workspace, "dist", "generatedPackageMetadata.js"),
    );
    for (const name of ["manifest.json", "rea-windows-x64.node"])
      await copyFile(
        join(artifact, name),
        join(workspace, "native", "windows", "build", name),
      );
    const require = createRequire(join(root, "package.json"));
    await mkdir(join(workspace, "node_modules"));
    await symlink(
      dirname(require.resolve("zod/package.json")),
      join(workspace, "node_modules", "zod"),
      "junction",
    );
    const loader = pathToFileURL(
      join(workspace, "dist", "windows", "WindowsNativeLoader.js"),
    ).href;
    const fixture = join(workspace, "probe.mjs");
    await writeFile(fixture, inspectionProbeSource(loader));
    for (const mode of ["retry", "teardown"]) {
      const temp = join(workspace, mode);
      await mkdir(temp);
      const observed = JSON.parse(
        execFileSync(process.execPath, [fixture, mode], {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
          env: { ...process.env, TEMP: temp, TMP: temp },
        }),
      );
      assert.equal(observed.mode, mode);
      await assertInspectionCleanup(temp, observed);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, controlledDispositionFailure: true, retainedOwner: true, renamePreservesOwnedIdentity: true, foreignReplacementPreserved: true, retryRecovers: true, successfulAdmissionCached: true, environmentTeardownCleansProbe: true, issue1701HostCauseReproduced: false })}\n`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
