const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const entry = resolve(__dirname, "../app/scripts/rea.mjs");
process.argv[1] = entry;
// Clear package-manager context only in this child, preserving the caller.
delete process.env.npm_command;
import(pathToFileURL(entry).href);
