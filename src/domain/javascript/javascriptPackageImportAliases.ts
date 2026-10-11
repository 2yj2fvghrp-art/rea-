/**
 * Exact package-private import-alias lookup. Node resolves `#` specifiers
 * against the importer's enclosing package `imports` map; this module owns the
 * specifier and exact-key rules. Condition, array, and null target selection
 * stay with the shared package-target machinery. Wildcard keys, recursive
 * `#` targets, and external-package targets remain explicit unknowns.
 */

/** How one `#` specifier participates in exact import-alias lookup. */
export type PackageImportSpecifierClassification =
  | { readonly kind: "invalid" }
  | { readonly kind: "pattern" }
  | { readonly kind: "exact"; readonly key: string };

/** Outcome of looking up one exact `#` key in a package `imports` object. */
export type PackageImportExactLookup =
  | { readonly kind: "undefined-map" }
  | {
      readonly kind: "missing-key";
      readonly declared: readonly string[];
    }
  | {
      readonly kind: "pattern-unresolved";
      readonly declared: readonly string[];
    }
  | {
      readonly kind: "found";
      readonly target: unknown;
      readonly declared: readonly string[];
    };

/** How a selected string target is interpreted for package-private imports. */
export type PackageImportTargetClassification =
  | { readonly kind: "relative"; readonly target: string }
  | { readonly kind: "recursive"; readonly target: string }
  | { readonly kind: "external-package"; readonly target: string };

/**
 * Classify a `#` module specifier before any package-scope walk.
 * Reserved forms (`#`, `#/…`) are invalid; `*` and trailing `/` need pattern
 * expansion, which this increment does not perform.
 */
export const classifyPackageImportSpecifier = (
  specifier: string,
): PackageImportSpecifierClassification => {
  if (specifier === "#" || specifier.startsWith("#/"))
    return { kind: "invalid" };
  if (specifier.includes("*") || specifier.endsWith("/"))
    return { kind: "pattern" };
  return { kind: "exact", key: specifier };
};

/** True when an `imports` key is a pattern rather than an exact alias. */
export const isPackageImportPatternKey = (key: string): boolean =>
  key.includes("*") || key.endsWith("/");

/**
 * Look up one exact `#` key in a package `imports` value.
 * A missing exact key is reported as missing when every declared key is also
 * exact; if the map contains pattern keys, the miss stays pattern-unresolved
 * rather than claiming the specifier is undefined.
 */
export const lookupExactPackageImport = (
  imports: unknown,
  key: string,
): PackageImportExactLookup => {
  if (typeof imports !== "object" || imports === null || Array.isArray(imports))
    return { kind: "undefined-map" };
  const declared = Object.keys(imports);
  if (Object.hasOwn(imports, key) && !isPackageImportPatternKey(key))
    return {
      kind: "found",
      target: Reflect.get(imports, key),
      declared,
    };
  return declared.some(isPackageImportPatternKey)
    ? { kind: "pattern-unresolved", declared }
    : { kind: "missing-key", declared };
};

/**
 * Classify a selected string import target. Only package-local `./` paths are
 * resolved as files; recursive `#` aliases and other specifiers stay unknown.
 */
export const classifyPackageImportTargetString = (
  target: string,
): PackageImportTargetClassification => {
  if (target.startsWith("./")) return { kind: "relative", target };
  if (target.startsWith("#")) return { kind: "recursive", target };
  return { kind: "external-package", target };
};
