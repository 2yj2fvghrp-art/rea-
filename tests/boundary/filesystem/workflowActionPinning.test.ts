import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const github = new URL("../../../.github/", import.meta.url);

const workflowFiles = async (): Promise<readonly URL[]> => {
  const entries = await readdir(github, { recursive: true });
  return entries
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .map((entry) => new URL(entry.replaceAll("\\", "/"), github));
};

// A moved tag would change the code that runs with release-please, npm
// publish, and Cloudflare credentials, so external actions name a commit.
it("pins every external workflow action to a full commit SHA", async () => {
  const unpinned: string[] = [];
  for (const file of await workflowFiles()) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) {
      const reference = match[1] ?? "";
      if (reference.startsWith("./")) continue;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u.test(reference))
        unpinned.push(`${file.pathname}: ${reference}`);
    }
  }
  expect(unpinned).toEqual([]);
});
