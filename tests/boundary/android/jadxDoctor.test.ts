import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { inspectJadxProvider } from "../../../src/android/JadxDoctor.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeJadxJarInventory } from "../../fixtures/android/jadxJar.js";

const it = test.skipIf(process.platform === "win32");

it("publishes REA_JADX_MCP_JAR as registration environment when the configured JAR validates", async () => {
  const root = await createTestTempDirectory("rea-jadx-doctor-");
  const jar = join(root, "jadx-headless-mcp.jar");
  const javaHome = await createFakeJdk(root);
  await writeJadxJarInventory(jar);

  const inspection = await inspectJadxProvider({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: javaHome,
  });

  expect(inspection).toMatchObject({
    id: "jadx",
    configured: true,
    available: true,
    providerVersion: null,
    registrationEnvironment: { REA_JADX_MCP_JAR: await realpath(jar) },
    checks: [
      {
        name: "configuration",
        ok: true,
        code: null,
        classification: "config_drift",
      },
    ],
  });
});

it("publishes no registration environment when REA_JADX_MCP_JAR is unset", async () => {
  const inspection = await inspectJadxProvider({});

  expect(inspection).toMatchObject({
    id: "jadx",
    configured: false,
    available: false,
    providerVersion: null,
    registrationEnvironment: {},
    checks: [
      {
        name: "configuration",
        ok: false,
        code: "not_configured",
        classification: "missing_analysis_engine",
      },
    ],
  });
});

it("publishes no registration environment when the configured JAR fails validation", async () => {
  const root = await createTestTempDirectory("rea-jadx-doctor-invalid-");
  const jar = join(root, "engine.jar");
  const javaHome = await createFakeJdk(root);
  await writeFile(jar, "not a Java archive");

  const inspection = await inspectJadxProvider({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: javaHome,
  });

  expect(inspection).toMatchObject({
    id: "jadx",
    configured: true,
    available: false,
    registrationEnvironment: {},
    checks: [
      {
        name: "configuration",
        ok: false,
        code: "version_unresolved",
        classification: "config_drift",
      },
    ],
  });
  expect(inspection.checks[0]?.detail).toContain("REA_JADX_MCP_JAR");
});

it("classifies a missing Java runtime as a missing dependency", async () => {
  const root = await createTestTempDirectory("rea-jadx-doctor-runtime-");
  const jar = join(root, "jadx-headless-mcp.jar");
  await writeJadxJarInventory(jar);

  const inspection = await inspectJadxProvider({
    REA_JADX_MCP_JAR: jar,
    JAVA_HOME: join(root, "missing-jdk"),
  });

  expect(inspection).toMatchObject({
    configured: true,
    available: false,
    registrationEnvironment: {},
    checks: [
      {
        name: "configuration",
        ok: false,
        code: "runtime_missing",
        classification: "missing_dependency",
      },
    ],
  });
});

const createFakeJdk = async (root: string): Promise<string> => {
  const javaHome = join(root, "fake-jdk");
  const bin = join(javaHome, "bin");
  const java = join(bin, "java");
  await mkdir(bin, { recursive: true });
  await writeFile(
    java,
    "#!/bin/sh\nprintf 'java.base@21\\njdk.compiler@21\\n'\n",
  );
  await chmod(java, 0o700);
  return javaHome;
};
