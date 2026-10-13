import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { exec } from "./lib/verify-package-core.mjs";

/** Exercise the UI server and assets from the actual npm tarball. */
export async function verifyPackedResearchUi({ tarball, workspace }) {
  const extracted = join(workspace, "research-ui-package");
  await mkdir(extracted);
  await exec("tar", ["-xf", tarball, "-C", extracted]);
  const entrypoint = pathToFileURL(
    join(extracted, "package", "scripts", "serve-research-ui.mjs"),
  ).href;
  const { createResearchUiServer } = await import(entrypoint);
  const server = createResearchUiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("packed research UI did not bind a loopback port");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const page = await fetch(origin);
    if (
      page.status !== 200 ||
      page.headers.get("cache-control") !== "no-store" ||
      !(await page.text()).includes("REA Research Case")
    )
      throw new Error("packed research UI did not serve its case page");
    const script = await fetch(`${origin}/app.js`);
    if (script.status !== 200 || !(await script.text()).includes("./case.js"))
      throw new Error("packed research UI did not serve its case logic");
    const caseModule = await fetch(`${origin}/case.js`);
    if (
      caseModule.status !== 200 ||
      !(await caseModule.text()).includes("startingCommand")
    )
      throw new Error("packed research UI did not serve its case model");
    if ((await fetch(`${origin}/../package.json`)).status !== 404)
      throw new Error(
        "packed research UI exposed files outside its asset routes",
      );
  } finally {
    server.close();
    await once(server, "close");
  }
}
