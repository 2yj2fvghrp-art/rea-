import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = (
  path: readonly (string | null)[],
): readonly (string | null)[] => {
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (GLOBAL_OBJECT_NAMES.includes(path[firstProperty] ?? ""))
    firstProperty += 1;
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Write lookup retains every visible initializer: reassigning an alias
 * later cannot erase a possible earlier mutation. Intrinsic reads stay strict.
 */
const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
) => {
  const cached = new WeakMap<t.Node, readonly AmbientPath[]>();
  return (node: t.Node): readonly AmbientPath[] => {
    const prior = cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    const pending: {
      node: t.Node;
      suffix: AmbientPath;
      visited: Set<string>;
    }[] = [{ node, suffix: [], visited: new Set() }];
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const { root, members } = electronMemberPath(current.node);
      const suffix = [...members, ...current.suffix];
      const continueWith = (node: t.Node, path: AmbientPath = suffix) =>
        pending.push({ node, suffix: path, visited: new Set(current.visited) });
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      ) {
        retain(["import-meta", ...suffix]);
        continue;
      }
      if (t.isIdentifier(root)) {
        if (globalObjectName(root, state) !== undefined) {
          retain(["global", ...suffix]);
          continue;
        }
        if (isUnshadowedGlobal(root, state, root.name)) {
          retain(["global", root.name, ...suffix]);
          continue;
        }
        const binding = resolveSemanticBindingState(state, root, root.name);
        if (binding === undefined || current.visited.has(binding.bindingId))
          continue;
        const stable = semanticStableInitializer(binding, state);
        const initializers = possibleWrites
          ? binding.initializers
          : stable === undefined
            ? []
            : [stable];
        current.visited.add(binding.bindingId);
        for (const initializer of initializers)
          pending.push({
            node: initializer.node,
            suffix: [
              ...initializer.projection.map((key) =>
                key === null ? null : String(key),
              ),
              ...suffix,
            ],
            visited:
              initializers.length === 1
                ? current.visited
                : new Set(current.visited),
          });
        continue;
      }
      if (possibleWrites && t.isConditionalExpression(root)) {
        continueWith(root.consequent);
        continueWith(root.alternate);
        continue;
      }
      if (possibleWrites && t.isLogicalExpression(root)) {
        continueWith(root.left);
        continueWith(root.right);
        continue;
      }
      const key = suffix[0];
      if (key === undefined) continue;
      if (t.isObjectExpression(root)) {
        if (possibleWrites) {
          for (const property of root.properties) {
            if (t.isSpreadElement(property)) continueWith(property.argument);
            else if (
              t.isObjectProperty(property) &&
              t.isExpression(property.value)
            ) {
              const ownKey = semanticStaticPropertyKey(
                property.key,
                property.computed,
              );
              if (key === null || ownKey === null || ownKey === key)
                continueWith(property.value, suffix.slice(1));
            }
          }
        } else if (
          key !== null &&
          root.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        ) {
          const property = root.properties.findLast(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) ===
                key,
          );
          if (t.isObjectProperty(property) && t.isExpression(property.value))
            continueWith(property.value, suffix.slice(1));
        }
      } else if (
        t.isArrayExpression(root) &&
        !root.elements.some(t.isSpreadElement)
      ) {
        const index = Number(key);
        if (key === null && possibleWrites) {
          for (const element of root.elements)
            if (t.isExpression(element)) continueWith(element, suffix.slice(1));
        } else if (
          key !== null &&
          Number.isInteger(index) &&
          index >= 0 &&
          String(index) === key
        ) {
          const element = root.elements[index];
          if (t.isExpression(element)) continueWith(element, suffix.slice(1));
        }
      }
    }
    const paths = [...result.values()];
    cached.set(node, paths);
    return paths;
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const ambientWrites = createAmbientPathResolver(state, true);
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind) => {
      if (kind === "opaque-call") return [];
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      return ambientWrites(root);
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
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
