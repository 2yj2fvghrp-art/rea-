#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { createResearchUiServer } from "./serve-research-ui.mjs";
import {
  caseToMarkdown,
  missingCaseFacts,
  normalizeCase,
  startingCommand,
} from "../research-ui/case.js";

const researchCase = normalizeCase({
  schema_version: 1,
  fields: {
    programName: "Synthetic program",
    programUrl: "https://example.test/program",
    participation: "joined",
    participationCheckedAt: "2026-10-13T12:00:00+11:00",
    policyUrl: "https://example.test/rules",
    policyCapturedAt: "2026-10-13T12:00:00+11:00",
    policyText: "Only com.example.app is in scope.\n~~~\nNo live tests.",
    policyCopyPath: "/tmp/synthetic-policy.txt",
    exclusions: "All other assets",
    allowedTechniques: "Offline static inspection",
    prohibitedTechniques: "Live requests",
    limits: "No live traffic",
    accountRules: "No test account needed",
    privacyRules: "No personal data",
    artifactType: "android",
    artifactIdentifier: "com.example.app",
    artifactPath: "/tmp/app's build.apk",
    artifactSource: "Synthetic fixture",
    artifactSha256: "a".repeat(64),
    artifactVersion: "1.0 (1)",
    reportChannel: "Program report form",
    disclosureRules: "Program report only",
    analysisLog: "2026-10-13T12:01:00+11:00: local APK inspection",
  },
  scopes: [
    {
      kind: "android_package",
      identifier: "com.example.app",
      versions: "1.0",
      policy_reference: "Scope section",
    },
  ],
  findings: [
    { id: "C-1", title: "Candidate only", unknowns: "Runtime behavior" },
  ],
});

assert.deepEqual(missingCaseFacts(researchCase), []);
assert.equal(
  startingCommand(researchCase),
  "rea inspect-android-package '/tmp/app'\\''s build.apk' --json",
);
assert.equal(
  startingCommand({
    ...researchCase,
    fields: {
      ...researchCase.fields,
      artifactPath: "C:\\Research\\app's build.apk",
    },
  }),
  "rea inspect-android-package 'C:\\Research\\app''s build.apk' --json",
);
const markdown = caseToMarkdown(researchCase);
assert.match(markdown, /Synthetic program/);
assert.match(markdown, /Only com\.example\.app is in scope\./);
assert.match(markdown, /Candidate only/);
assert.match(markdown, /local APK inspection/);
assert.match(markdown, /~~~~\nOnly com\.example\.app/);
assert.throws(() => normalizeCase({ schema_version: 99 }), /version 1/);
assert.throws(
  () => normalizeCase({ schema_version: 1, scopes: Array(101).fill({}) }),
  /100 scope/,
);

const server = createResearchUiServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${String(address.port)}`;
try {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /connect-src 'none'/,
  );
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /REA Research Case/);

  const script = await fetch(`${origin}/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /\.\/case\.js/);

  const caseModule = await fetch(`${origin}/case.js`);
  assert.equal(caseModule.status, 200);
  assert.match(await caseModule.text(), /startingCommand/);

  assert.equal((await fetch(`${origin}/../package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/`, { method: "POST" })).status, 405);
} finally {
  server.close();
  await once(server, "close");
}
process.stdout.write(
  "Research UI static server and case export checks passed.\n",
);
