import * as t from "@babel/types";
import { semanticStaticPropertyKey } from "./javascriptAstValues.js";

/** Literal external-module target for either value or erased import-equals syntax. */
export const typescriptImportEqualsRequest = (
  node: t.TSImportEqualsDeclaration,
  parents?: Pick<WeakMap<t.Node, t.Node>, "get">,
): {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly resolutionMode: "require";
  readonly exportedName: string | null;
  readonly locationNode: t.Node;
} | null => {
  if (
    !t.isTSExternalModuleReference(node.moduleReference) ||
    !t.isStringLiteral(node.moduleReference.expression)
  )
    return null;
  const parent = parents?.get(node);
  const exported =
    t.isExportNamedDeclaration(parent) && parent.declaration === node
      ? parent
      : undefined;
  return {
    specifier: node.moduleReference.expression.value,
    typeOnly: node.importKind === "type",
    resolutionMode: "require",
    exportedName: exported === undefined ? null : node.id.name,
    locationNode: exported ?? node,
  };
};

/** Read only explicit type-reference attributes; never evaluate an options expression. */
export const typescriptImportResolutionMode = (
  node: t.Node,
): "import" | "require" | "compiler-dependent" | undefined => {
  if (t.isTSImportType(node)) {
    if (node.options == null) return undefined;
    const attributes = literalProperty(node.options, "with");
    const mode = literalProperty(attributes, "resolution-mode");
    return t.isStringLiteral(mode) &&
      (mode.value === "import" || mode.value === "require")
      ? mode.value
      : "compiler-dependent";
  }
  if (
    !t.isImportDeclaration(node) &&
    !t.isExportNamedDeclaration(node) &&
    !t.isExportAllDeclaration(node)
  )
    return undefined;
  const kind = t.isImportDeclaration(node) ? node.importKind : node.exportKind;
  if (kind !== "type") return undefined;
  const attributes = node.attributes;
  if (attributes == null || attributes.length === 0) return undefined;
  const attribute = attributes[0];
  if (
    attributes.length !== 1 ||
    attribute === undefined ||
    (t.isStringLiteral(attribute.key)
      ? attribute.key.value
      : attribute.key.name) !== "resolution-mode"
  )
    return "compiler-dependent";
  const mode = attribute.value.value;
  return mode === "import" || mode === "require" ? mode : "compiler-dependent";
};

const literalProperty = (
  node: t.Node | null | undefined,
  key: string,
): t.Node | undefined =>
  t.isObjectExpression(node) &&
  node.properties.length === 1 &&
  t.isObjectProperty(node.properties[0]) &&
  semanticStaticPropertyKey(
    node.properties[0].key,
    node.properties[0].computed,
  ) === key
    ? node.properties[0].value
    : undefined;

/** Literal source and type selection, including indexed access owned by enclosing AST nodes. */
export const typescriptImportTypeRequest = (
  node: t.TSImportType,
  parents?: Pick<WeakMap<t.Node, t.Node>, "get">,
): {
  readonly specifier: string;
  readonly path: readonly string[];
  readonly dynamicMemberAccess: boolean;
  readonly locationNode: t.Node;
} | null => {
  if (!t.isStringLiteral(node.source)) return null;
  const names: string[] = [];
  let qualifier = node.qualifier;
  while (t.isTSQualifiedName(qualifier)) {
    names.unshift(qualifier.right.name);
    qualifier = qualifier.left;
  }
  if (t.isIdentifier(qualifier)) names.unshift(qualifier.name);
  let cursor: t.Node = node;
  let locationNode: t.Node = node;
  let dynamicMemberAccess = false;
  for (;;) {
    const parent: t.Node | undefined = parents?.get(cursor);
    if (
      (t.isTSParenthesizedType(parent) && parent.typeAnnotation === cursor) ||
      (t.isTSTypeQuery(parent) && parent.exprName === cursor)
    ) {
      cursor = parent;
      continue;
    }
    if (!t.isTSIndexedAccessType(parent) || parent.objectType !== cursor) break;
    locationNode = parent;
    const literal = t.isTSLiteralType(parent.indexType)
      ? parent.indexType.literal
      : undefined;
    const key =
      t.isStringLiteral(literal) || t.isNumericLiteral(literal)
        ? String(literal.value)
        : t.isTemplateLiteral(literal) && literal.expressions.length === 0
          ? literal.quasis[0]?.value.cooked
          : undefined;
    if (key == null) {
      dynamicMemberAccess = true;
      break;
    }
    names.push(key);
    cursor = parent;
  }
  return {
    specifier: node.source.value,
    path: names,
    dynamicMemberAccess,
    locationNode,
  };
};
