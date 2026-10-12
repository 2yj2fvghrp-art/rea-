import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export async function portableDependencies(root, lock, platform, architecture) {
  const platformMismatch = (entry) =>
    (entry.os !== undefined && !entry.os.includes(platform)) ||
    (entry.cpu !== undefined && !entry.cpu.includes(architecture));
  const present = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    try {
      await lstat(join(root, path));
      present.add(path);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }

  // Only root optional providers may be absent as a whole. An enabled package's
  // host-specific optional dependencies (such as the PTY binary) remain required.
  const enabled = new Set();
  function visit(owner) {
    if (enabled.has(owner)) return;
    enabled.add(owner);
    const entry = lock.packages[owner];
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      const path = resolveDependency(owner, name, lock.packages);
      const optional = Object.hasOwn(entry.optionalDependencies ?? {}, name);
      if (optional && platformMismatch(lock.packages[path])) continue;
      if (owner === "" && optional && !present.has(path)) continue;
      visit(path);
    }
  }
  visit("");

  const dependencies = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    if (!present.has(path)) {
      if (entry.optional && (platformMismatch(entry) || !enabled.has(path)))
        continue;
      throw new Error(`Installed dependency is missing: ${path}`);
    }
    const source = join(root, path);
    const installed = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    if (installed.version !== entry.version)
      throw new Error(
        `Installed dependency differs from the lockfile: ${path}`,
      );
    dependencies.push({ path, version: installed.version });
  }
  return dependencies;
}

function resolveDependency(owner, name, packages) {
  // Lockfile package keys use POSIX separators even on Windows. Follow Node's
  // ancestor node_modules lookup rather than assuming every dependency is hoisted.
  let parent = owner;
  for (;;) {
    const candidate = posix.join(parent, "node_modules", name);
    if (
      posix.basename(parent) !== "node_modules" &&
      Object.hasOwn(packages, candidate)
    )
      return candidate;
    if (parent === "")
      throw new Error(
        `Lockfile dependency is missing: ${owner || "root"} -> ${name}`,
      );
    const next = posix.dirname(parent);
    parent = next === "." ? "" : next;
  }
}
