#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stderr.write("rea-gui is available only on Windows.\n");
  process.exitCode = 1;
} else {
  const scriptPath = fileURLToPath(new URL("./rea-gui.ps1", import.meta.url));
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      scriptPath,
    ],
    {
      stdio: "inherit",
    },
  );
  child.once("error", (cause) => {
    process.stderr.write(
      `Could not start the REA desktop GUI: ${String(cause)}\n`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
