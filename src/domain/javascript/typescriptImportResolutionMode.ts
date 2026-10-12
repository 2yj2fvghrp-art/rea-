import type {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
} from "@babel/types";

/** An explicit type import/export attribute overrides the file's loader default. */
export const typescriptImportResolutionMode = (
  node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration,
): "import" | "require" | undefined => {
  const kind =
    node.type === "ImportDeclaration" ? node.importKind : node.exportKind;
  if (kind !== "type") return undefined;
  const attribute = node.attributes?.find(
    ({ key }) =>
      (key.type === "StringLiteral" ? key.value : key.name) ===
      "resolution-mode",
  );
  const mode = attribute?.value.value;
  return mode === "import" || mode === "require" ? mode : undefined;
};
