import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { resolveJavaScriptIntrinsicInvocation } from "./javascriptIntrinsicInvocation.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/**
 * Index direct writes to globals and import.meta after declarations are known.
 * This shares the identity-write owner's assignment, destructuring, loop and
 * intrinsic-mutator rules. Runtime reachability, indirect aliases and arbitrary
 * call side effects are not evaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const intrinsicPath = (node: t.Node): readonly string[] | undefined => {
    const { root, members } = electronMemberPath(node);
    if (members.some((member) => member === null)) return undefined;
    const path = members as readonly string[];
    if (
      isUnshadowedGlobal(root, state, "Object") ||
      isUnshadowedGlobal(root, state, "Reflect")
    )
      return ["intrinsic", (root as t.Identifier).name, ...path];
    return globalObjectName(root, state) === undefined
      ? undefined
      : ["intrinsic", ...path];
  };
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind) => {
      if (kind === "opaque-call") return undefined;
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      )
        return ["import-meta"];
      if (!t.isIdentifier(root)) return undefined;
      if (kind === "member" && globalObjectName(root, state) !== undefined)
        return ["global"];
      return isUnshadowedGlobal(root, state, root.name)
        ? ["global", root.name]
        : undefined;
    },
    (node) =>
      resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        () => undefined,
        () => false,
      ),
    (node) => {
      if (node === undefined) return undefined;
      return semanticStaticPropertyKey(node, true) ?? undefined;
    },
    (node) => t.isObjectExpression(node) || t.isArrayExpression(node),
    (_node, path) => {
      state.ambientWrites.retain(path);
    },
  );
}

/**
 * Recognize an ambient name or direct global-object property without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean => {
  const node = unwrapJavaScriptExpression(callee).node;
  if (state.ambientWrites.covers(["global", name])) return false;
  if (isUnshadowedGlobal(node, state, name)) return true;
  if (
    !t.isMemberExpression(node) ||
    semanticStaticPropertyKey(node.property, node.computed) !== name
  )
    return false;
  const root = unwrapJavaScriptExpression(node.object).node;
  const namespace = globalObjectName(root, state);
  return (
    namespace !== undefined &&
    !state.ambientWrites.covers(["global", namespace])
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
