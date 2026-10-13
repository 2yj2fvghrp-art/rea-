import { basename, dirname, join } from "node:path";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import type { RecoveryInputSnapshot } from "./RecoveryFiles.js";

const FILE_NAME_MAX_BYTES = 255;

/** Keep the selected layout where safe, and give every published script a JS extension. */
const moduleName = (source: RecoveryInputSnapshot, single: boolean): string => {
  let name = source.relative_path;
  if (single) {
    const selectedName = basename(source.path);
    try {
      if (normalizeArtifactPath(selectedName) === selectedName)
        name = selectedName;
    } catch {
      // The snapshot already owns a safe fallback for a native-only basename.
    }
  }
  const withExtension = /\.(?:[cm]?js|jsx)$/i.test(name) ? name : `${name}.js`;
  if (Buffer.byteLength(basename(withExtension)) <= FILE_NAME_MAX_BYTES)
    return withExtension;
  const replacement = `__rea_${source.sha256.slice(0, 16)}.js`;
  return dirname(withExtension) === "."
    ? replacement
    : join(dirname(withExtension), replacement);
};

/**
 * Allocate the complete output layout before any producer can overwrite a selected input's output.
 * Inputs published under their own relative path keep it; renamed inputs take aliases on collision,
 * so an import of a selected file still resolves to that file's recovered output.
 */
export const moduleNames = (
  sources: readonly RecoveryInputSnapshot[],
): readonly string[] => {
  const desired = sources.map((source) =>
    moduleName(source, sources.length === 1),
  );
  const renamed = (index: number): number =>
    Number(desired[index] !== sources[index]?.relative_path);
  const order = desired
    .map((_, index) => index)
    .sort((left, right) => renamed(left) - renamed(right));
  const allocated = new Set<string>();
  const names: string[] = [];
  const overlaps = (left: string, right: string): boolean =>
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`);
  for (const index of order) {
    const name = desired[index] ?? "";
    let candidate = name;
    let suffix = 0;
    while (
      [...allocated].some((used) => overlaps(used, candidate)) ||
      desired.some(
        (reserved, other) =>
          other !== index &&
          reserved !== candidate &&
          overlaps(reserved, candidate),
      )
    ) {
      suffix += 1;
      candidate = `__rea_recovered_${String(index + 1)}_${String(suffix)}/${basename(name)}`;
    }
    allocated.add(candidate);
    names[index] = candidate;
  }
  return names;
};
