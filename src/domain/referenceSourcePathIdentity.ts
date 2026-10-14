export interface ReferenceSourcePathLookup {
  readonly resolve: (path: string) => string | undefined;
  readonly resolveCandidates: (paths: readonly string[]) => string | undefined;
  /** Resolve this relative path or its nearest recorded parent directory. */
  readonly resolveAncestor: (path: string) => string | undefined;
}

interface PathIndex {
  readonly children: Map<string, PathIndex>;
  value?: string | null;
}

const indexPaths = (
  paths: Iterable<readonly [string, string | null]>,
): PathIndex => {
  const root: PathIndex = { children: new Map() };
  for (const [path, value] of paths) {
    let node = root;
    for (const part of path.split("/")) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.value = value;
  }
  return root;
};

/**
 * Reference inventories retain filesystem spelling. Prefer that exact identity;
 * canonical Unicode equivalence is a fallback only when it identifies one entry.
 */
export const createReferenceSourcePathLookup = (
  paths: Iterable<string>,
): ReferenceSourcePathLookup => {
  const exact = new Set(paths);
  const canonical = new Map<string, string | null>();
  for (const path of exact) {
    const key = path.normalize("NFC");
    canonical.set(key, canonical.has(key) ? null : path);
  }
  const equivalent = (path: string): string | undefined =>
    canonical.get(path.normalize("NFC")) ?? undefined;
  const resolve = (path: string): string | undefined =>
    exact.has(path) ? path : equivalent(path);
  let ancestorIndexes: readonly [PathIndex, PathIndex] | undefined;
  return {
    resolve,
    resolveCandidates: (candidates) =>
      candidates.find((path) => exact.has(path)) ??
      candidates.map(equivalent).find((path) => path !== undefined),
    resolveAncestor: (path) => {
      // Build only for ancestor consumers; normalize each query once instead
      // of repeatedly normalizing and hashing successively shorter prefixes.
      ancestorIndexes ??= [
        indexPaths([...exact].map((path) => [path, path] as const)),
        indexPaths(canonical),
      ];
      let exactNode: PathIndex | undefined = ancestorIndexes[0];
      let canonicalNode: PathIndex | undefined = ancestorIndexes[1];
      const normalized = path.normalize("NFC").split("/");
      let found: string | undefined;
      for (const [index, part] of path.split("/").entries()) {
        exactNode = exactNode?.children.get(part);
        canonicalNode = canonicalNode?.children.get(normalized[index]!);
        const value = exactNode?.value ?? canonicalNode?.value;
        if (value !== undefined) found = value ?? undefined;
        if (exactNode === undefined && canonicalNode === undefined) break;
      }
      return found;
    },
  };
};

/** Symlink evidence can originate on a different OS from the graph reader. */
export const isPortableAbsoluteReferenceTarget = (target: string): boolean =>
  target.startsWith("/") ||
  /^[A-Za-z]:[\\/]/u.test(target) ||
  /^\\\\[^\\/]+[\\/][^\\/]+/u.test(target);
