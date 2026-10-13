import * as t from "@babel/types";

import { htmlUrlText, stripQueryAndFragment } from "../artifactPathSyntax.js";
import { sanitizeEndpointCandidate } from "../browserObservation.js";
import {
  addFindingOnce,
  addLocatedFinding,
} from "./javascriptStaticAnalysisFindings.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentNode,
  argumentValue,
  calleeName,
  endpointArgument as endpointArgumentHelper,
  isFileIdentity,
  prefixedArgument,
  range,
  rangeForOffsets,
  sourceSlice,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type {
  JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  JavaScriptEndpointInput as EndpointInput,
  JavaScriptFindingContext as FindingContext,
  JavaScriptModuleRange,
  JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";

type JavaScriptCallLike =
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression;

/** Inspect one call or new expression for references, endpoints, storage, and roles. */
export const inspectCall = (
  source: string,
  node: JavaScriptCallLike,
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const module = context.accumulator.moduleRangeIndex.find(node.start);
  const moduleRequireName = module?.requireName ?? null;
  const requireCall = requireCallSpecifier(node, name, module, bindings);
  if (requireCall !== null)
    addReference(context, {
      node,
      kind: "require",
      specifier: requireCall.specifier,
    });
  const chunkLoad = chunkLoadSpecifier(node, name, moduleRequireName);
  if (chunkLoad !== null)
    addReference(context, {
      node,
      kind: "dynamic-import",
      specifier: chunkLoad.specifier,
    });
  for (const specifier of vitePreloadDependencySpecifiers(source, node, name))
    addReference(context, { node, kind: "dynamic-import", specifier });
  const worker = t.isNewExpression(node) ? node : undefined;
  const workerConstructor =
    worker === undefined
      ? undefined
      : workerConstructorKind(worker.callee, bindings);
  if (
    workerConstructor !== undefined ||
    name === "Worker" ||
    name.endsWith(".Worker")
  )
    addReference(context, {
      node,
      kind: "worker",
      // Node string paths use the process cwd or filesystem root, neither of
      // which is established by the analyzed source's artifact location.
      specifier:
        (workerConstructor === "node" ? undefined : first) ??
        (workerConstructor === undefined || worker === undefined
          ? undefined
          : workerUrlSpecifier(worker, bindings)),
    });
  if (name.endsWith("serviceWorker.register"))
    addReference(context, { node, kind: "service-worker", specifier: first });
  inspectEndpointCall(node, name, first, context);
  inspectStorageCall(node, name, first, context);
  if (first === "audio" || first === "video")
    noteMediaElementPreloads(node, accumulator);
  if (name.endsWith("loadFile") && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "filesystem-expression",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
  if (name.endsWith("loadURL") && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "module-specifier",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
};

const workerUrlSpecifier = (
  worker: t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): string | undefined => {
  const argumentExpression = argumentNode(worker.arguments[0]);
  if (argumentExpression === undefined) return undefined;
  const node = unwrapJavaScriptExpression(argumentExpression).node;
  if (!t.isNewExpression(node)) return undefined;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    !isUnmodifiedGlobalReference(callee, bindings, "URL") ||
    !isUnmodifiedImportMetaUrl(argumentNode(node.arguments[1]), bindings)
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  if (specifier === undefined) return undefined;
  const pathname = stripQueryAndFragment(specifier);
  // The module URL's scheme and filesystem/origin root are unavailable. Only
  // relative pathnames can establish a location within the artifact; retain
  // rooted paths and paths requiring URL text normalization as expressions.
  // Malformed percent escapes survive HTTP URL parsing but cannot be converted
  // from a file URL to a Node Worker path. Without the base scheme, keep that
  // ambiguity unknown; query and fragment bytes do not affect pathname lookup.
  return pathname.length > 0 &&
    !pathname.startsWith("/") &&
    !/%(?![0-9a-f]{2})/iu.test(pathname) &&
    stripQueryAndFragment(htmlUrlText(specifier)) === pathname
    ? specifier
    : undefined;
};

const workerConstructorKind = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): "browser" | "node" | undefined => {
  const node = unwrapJavaScriptExpression(callee).node;
  const member =
    t.isMemberExpression(node) &&
    semanticStaticPropertyName(node.property, node.computed) === "Worker";
  const root = unwrapJavaScriptExpression(member ? node.object : node).node;
  if (!t.isIdentifier(root)) return undefined;
  const browserGlobal = member
    ? ["globalThis", "window", "self"].includes(root.name)
    : root.name === "Worker";
  if (browserGlobal && isUnmodifiedGlobalReference(node, bindings, "Worker"))
    return "browser";
  const binding = resolveSemanticBindingState(bindings, root, root.name);
  const [origin] = binding?.directOrigins ?? [];
  // Named ESM exports and module namespace exports are read-only. Default
  // imports and CommonJS objects can replace Worker, so their identity is unknown.
  return binding?.runtimeImport === true &&
    binding.definitions.length === 1 &&
    binding.directOrigins.length === 1 &&
    origin !== undefined &&
    (origin.specifier === "worker_threads" ||
      origin.specifier === "node:worker_threads") &&
    (member
      ? origin.importedPath.length === 0
      : origin.importedPath.length === 1 && origin.importedPath[0] === "Worker")
    ? "node"
    : undefined;
};

// Element factories such as jsx("audio", props) and createElement("video",
// props) carry the HTML media `preload` hint ("none", "metadata", "auto"),
// which never names an Electron preload script.
const noteMediaElementPreloads = (
  node: JavaScriptCallLike,
  accumulator: AnalysisAccumulator,
): void => {
  const props = node.arguments[1];
  if (!t.isObjectExpression(props)) return;
  for (const property of props.properties)
    if (
      t.isObjectProperty(property) &&
      semanticStaticPropertyName(property.key, property.computed) === "preload"
    )
      accumulator.mediaElementPreloads.add(property);
};

const requireCallSpecifier = (
  node: JavaScriptCallLike,
  name: string,
  module: JavaScriptModuleRange | undefined,
  bindings: JavaScriptSemanticAnalysisState,
): { readonly specifier: string | undefined } | null => {
  const moduleRequireName = module?.requireName ?? null;
  if (name === "require" || name.endsWith(".require")) {
    // A bare `require` is the CommonJS loader only while its callee
    // identifier is lexically unbound. A local parameter, hoisted function,
    // catch binding or block binding shadows the wrapper loader, so the call
    // cannot be a module load. The binding index is consulted at the call
    // site; no file-wide walk is needed.
    if (name === "require" && isShadowedRequireCallee(node, module, bindings))
      return null;
    return { specifier: argumentValue(node.arguments[0]) };
  }
  if (name === "__webpack_require__" || name === moduleRequireName)
    return { specifier: argumentValue(node.arguments[0]) };
  if (
    name === "__webpack_require__.bind" ||
    (moduleRequireName !== null && name === `${moduleRequireName}.bind`)
  )
    return { specifier: argumentValue(node.arguments[1]) };
  return null;
};

/**
 * Decide whether a bare `require(...)` / `require?.(...)` callee resolves to
 * a local binding that shadows the CommonJS loader. Unbound identifiers keep
 * the loader; only a binding that provably retains or aliases the loader
 * (uninitialized top-level `var require`, direct `createRequire` alias)
 * preserves the candidate.
 */
const isShadowedRequireCallee = (
  node: JavaScriptCallLike,
  module: JavaScriptModuleRange | undefined,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isIdentifier(callee, { name: "require" })) return false;
  // An incomplete scope cannot prove shadowing; keep the candidate.
  if (semanticResolutionBlocked(bindings, callee, "require")) return false;
  const binding = resolveSemanticBindingState(bindings, callee, "require");
  if (binding === undefined) return false;
  // A bundle factory whose loader parameter is named `require` (e.g.
  // webpack's `(module, exports, require)`) is the recovered module loader,
  // not a shadow — while the binding still holds the loader parameter. A
  // hoisted `function`/`class` or initialized variable declaration in the
  // same scope replaces the parameter for the whole body, so a merged binding
  // with those is a local shadow, not the loader; an uninitialized `var`
  // redeclaration hoists without touching the parameter value, so it stays
  // loader-retaining. A nested binding with the same name resolves to a
  // different scope and stays shadowed. A write that takes effect before the
  // call replaces the loader for that call, so the call is shadowed; a later
  // write leaves earlier calls on the loader.
  if (
    module?.requireName === "require" &&
    module.loaderScopeId !== null &&
    binding.scopeId === module.loaderScopeId &&
    isLoaderRetainingParameterBinding(binding)
  )
    return requireWriteShadowsCall(
      requireWriteFacts(binding, bindings),
      node,
      bindings,
    );
  return !isRetainedRequireLoader(binding, node, bindings);
};

/**
 * The loader parameter still holds the loader when every definition is the
 * parameter itself, a plain assignment, or an uninitialized `var`
 * redeclaration — `var require;` hoists without touching the parameter value.
 * A declaration initializer would have replaced the parameter at declaration,
 * so the initializer list must hold exactly the assignment expressions.
 */
const isLoaderRetainingParameterBinding = (
  binding: JavaScriptSemanticBindingState,
): boolean => {
  const assignmentCount = binding.definitions.filter(
    ({ kind }) => kind === "assignment",
  ).length;
  return (
    binding.definitions.every(
      ({ kind, declarationKind }) =>
        kind === "parameter" ||
        kind === "assignment" ||
        (kind === "variable" && declarationKind === "var"),
    ) && binding.initializers.length === assignmentCount
  );
};

const isRetainedRequireLoader = (
  binding: JavaScriptSemanticBindingState,
  node: JavaScriptCallLike,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isDirectCreateRequireBinding(binding, state) ||
  isUninitializedTopLevelVarRequire(binding, state, node);

/**
 * `const require = createRequire(import.meta.url)` aliases the ESM loader.
 * The argument only selects the resolution base — `createRequire` returns a
 * loader for any file identity, so `__filename` and
 * `fileURLToPath(import.meta.url)` spellings qualify too. Erased TypeScript
 * syntax around the initializer (e.g. `as NodeRequire`) is unwrapped before
 * matching, mirroring the reference-source classifier.
 */
const isDirectCreateRequireBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const initializer = semanticStableInitializer(binding, state);
  if (initializer === undefined) return false;
  // Only a direct alias holds the loader: a destructured property of the
  // created require (e.g. `const { missing: require } = createRequire(...)`)
  // keeps a non-empty projection and is not the loader itself.
  if (initializer.projection.length > 0) return false;
  const init = unwrapJavaScriptExpression(initializer.node).node;
  if (!t.isCallExpression(init)) return false;
  const createRequireArgument = init.arguments[0];
  if (
    createRequireArgument === undefined ||
    !isFileIdentity(unwrapJavaScriptExpression(createRequireArgument).node)
  )
    return false;
  return isCreateRequireCallee(
    unwrapJavaScriptExpression(init.callee).node,
    state,
  );
};

/**
 * Match `createRequire` by its imported origin rather than one call spelling:
 * the named import (`createRequire(...)`), the namespace form
 * (`ns.createRequire(...)` where `ns` is `import * as ns from "node:module"`),
 * and the default-import form (`mod.createRequire(...)` where `mod` is
 * `import mod from "node:module"`). ESM import bindings are read-only, so
 * each form's identity is stable — including the default export, which is the
 * builtin module object itself.
 */
const isCreateRequireCallee = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (t.isIdentifier(callee)) {
    const calleeBinding = resolveSemanticBindingState(
      state,
      callee,
      callee.name,
    );
    const [origin] = calleeBinding?.directOrigins ?? [];
    return (
      calleeBinding?.runtimeImport === true &&
      origin !== undefined &&
      (origin.specifier === "node:module" || origin.specifier === "module") &&
      origin.importedPath.length === 1 &&
      origin.importedPath[0] === "createRequire"
    );
  }
  if (t.isMemberExpression(callee)) {
    if (
      semanticStaticPropertyName(callee.property, callee.computed) !==
      "createRequire"
    )
      return false;
    const object = unwrapJavaScriptExpression(callee.object).node;
    if (!t.isIdentifier(object)) return false;
    return isNodeModuleObjectBinding(
      resolveSemanticBindingState(state, object, object.name),
    );
  }
  return false;
};

/**
 * The builtin module object behind `import * as ns from "node:module"` or
 * `import mod from "node:module"`. ESM import bindings are read-only, so the
 * object's identity is stable in both forms — including the default export,
 * which is the builtin module object itself.
 */
const isNodeModuleObjectBinding = (
  binding: JavaScriptSemanticBindingState | undefined,
): boolean => {
  const [origin] = binding?.directOrigins ?? [];
  return (
    binding?.runtimeImport === true &&
    origin !== undefined &&
    (origin.specifier === "node:module" || origin.specifier === "module") &&
    (origin.importedPath.length === 0 ||
      (origin.importedPath.length === 1 &&
        origin.importedPath[0] === "default"))
  );
};

/**
 * An uninitialized top-level `var require` retains Node's wrapper loader, but
 * a later write replaces it. Only `var` qualifies: a block-scoped `let`
 * declaration never receives the wrapper loader, so `let require;` followed
 * by a call cannot be a module load.
 */
const isUninitializedTopLevelVarRequire = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  node: JavaScriptCallLike,
): boolean => {
  const facts = retainedRequireFacts(binding, state);
  if (!facts.declarationsOk) return false;
  return !requireWriteShadowsCall(facts.writes, node, state);
};

interface RequireWriteFact {
  readonly endLine: number;
  readonly endColumn: number;
  /** Nearest enclosing function of the write, or null at program top level. */
  readonly functionNode: t.Node | null;
}

interface RetainedRequireFacts {
  readonly declarationsOk: boolean;
  readonly writes: readonly RequireWriteFact[];
}

/**
 * Per-binding declaration facts for the uninitialized-`var`-require check.
 * Bindings are created once per analysis, so the definition scan and write
 * indexing run once per binding instead of once per bare `require` call.
 */
const retainedRequireFactsCache = new WeakMap<
  JavaScriptSemanticBindingState,
  RetainedRequireFacts
>();

const retainedRequireFacts = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): RetainedRequireFacts => {
  const cached = retainedRequireFactsCache.get(binding);
  if (cached !== undefined) return cached;
  const facts = computeRetainedRequireFacts(binding, state);
  retainedRequireFactsCache.set(binding, facts);
  return facts;
};

const computeRetainedRequireFacts = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): RetainedRequireFacts => {
  const assignmentCount = binding.definitions.filter(
    ({ kind }) => kind === "assignment",
  ).length;
  const declarationsOk =
    binding.kind === "variable" &&
    binding.definitions.every(
      ({ kind, declarationKind }) =>
        kind === "assignment" ||
        (kind === "variable" && declarationKind === "var"),
    ) &&
    // A declaration initializer means the loader was replaced at declaration.
    binding.initializers.length === assignmentCount &&
    // A rest-element declaration (`var {...require} = {}`) copies an object
    // or array into the binding through a reference initializer instead of a
    // value initializer, so the binding never holds the wrapper loader.
    !binding.referenceInitializers.some(
      (initializer) => initializer.copyKind !== undefined,
    ) &&
    state.scopesById.get(binding.scopeId)?.kind === "program";
  if (!declarationsOk) return { declarationsOk, writes: [] };
  return { declarationsOk: true, writes: requireWriteFacts(binding, state) };
};

/**
 * Positional write facts for a binding whose value flows only through plain
 * assignments. Each assignment pushes exactly one initializer (the
 * right-hand side for plain `=`, the full expression otherwise), in
 * definition order, so the i-th assignment pairs with initializers[i].
 * Callers must ensure no declaration initializer is present
 * (initializers.length === assignment count) before calling.
 */
const requireWriteFacts = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): readonly RequireWriteFact[] => {
  let assignmentIndex = 0;
  const writes: RequireWriteFact[] = [];
  for (const definition of binding.definitions) {
    if (definition.kind !== "assignment") continue;
    const initializer = binding.initializers[assignmentIndex];
    assignmentIndex += 1;
    if (initializer === undefined) continue;
    // A `for...of`/`for...in` write assigns the loop variable before each
    // body execution, so model the write at body entry: the statement end
    // would place a call inside the body before the write and invent a false
    // dependency. The iterable expression still evaluates before the write.
    const writeNode = initializer.node;
    const writePosition =
      t.isForOfStatement(writeNode) || t.isForInStatement(writeNode)
        ? range(writeNode.body).start
        : range(writeNode).end;
    const { line, column } = writePosition;
    writes.push({
      endLine: line,
      endColumn: column,
      functionNode: nearestFunctionNode(initializer.node, state),
    });
  }
  return writes;
};

/**
 * A call at or after an effective write in the same function scope no longer
 * sees the loader. A write takes effect when its assignment expression
 * finishes evaluating, so a call inside the write's own right-hand side
 * (e.g. `require = require("./dep.cjs")`) still sees the loader. A write
 * inside a function body only shadows calls in that same body: source order
 * cannot establish when the body runs relative to an outer call.
 */
const requireWriteShadowsCall = (
  writes: readonly RequireWriteFact[],
  node: JavaScriptCallLike,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const { line, column } = range(node).start;
  const callFunction = nearestFunctionNode(node, state);
  return writes.some(
    (write) =>
      (write.endLine < line ||
        (write.endLine === line && write.endColumn <= column)) &&
      (write.functionNode === null || write.functionNode === callFunction),
  );
};

/**
 * Nearest enclosing function of a node, or null at program top level. The
 * walk starts at the node's parent: a write whose right-hand side is itself
 * a function (e.g. `require = () => "local"`) still takes effect in the
 * enclosing body, not inside the assigned function. An incomplete parent
 * chain falls back to null, which keeps the previous positional behavior for
 * that write or call.
 */
const nearestFunctionNode = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node | null => {
  let current: t.Node | undefined = state.parentsByNode.get(node);
  while (current !== undefined) {
    if (t.isFunction(current)) return current;
    current = state.parentsByNode.get(current);
  }
  return null;
};

const chunkLoadSpecifier = (
  node: JavaScriptCallLike,
  name: string,
  moduleRequireName: string | null,
): { readonly specifier: string | undefined } | null => {
  if (
    name !== "__webpack_require__.e" &&
    (moduleRequireName === null || name !== `${moduleRequireName}.e`)
  )
    return null;
  return { specifier: prefixedArgument("chunk:", node.arguments[0]) };
};

const vitePreloadDependencySpecifiers = (
  source: string,
  node: JavaScriptCallLike,
  name: string,
): readonly string[] => {
  if (name !== "__vite__mapDeps" || !t.isArrayExpression(node.arguments[0]))
    return [];
  const indexes = node.arguments[0].elements.flatMap((element) =>
    t.isNumericLiteral(element) ? [element.value] : [],
  );
  if (indexes.length !== node.arguments[0].elements.length) return [];
  const table = vitePreloadDependencyTable(source);
  return indexes.flatMap((index) => table[index] ?? []);
};

const vitePreloadDependencyTable = (source: string): readonly string[] => {
  const match =
    /\.\s*f\s*\|\|\s*\(\s*[^)]*?\.f\s*=\s*\[([\s\S]*?)\]\s*\)/u.exec(source);
  const body = match?.[1];
  if (body === undefined) return [];
  return [
    ...body.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/gu),
  ].map((literal) => literal[1] ?? literal[2] ?? "");
};

const inspectEndpointCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const route = STATIC_ROUTE_CALL_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`.${candidate}`),
  );
  if (route && first !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value: first,
      mechanism: `call:${name}`,
    });
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const endpoint = endpointArgumentHelper(
    name,
    node.arguments,
    node.callee,
    receiverFact,
  );
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint,
      mechanism: `call:${name}`,
    });
};

/** Record tRPC procedures, tRPC link URLs and named GraphQL operations. */
export const inspectRpcNode = (node: t.Node, context: FindingContext): void => {
  const rpc = context.rpcScan.inspect(node);
  if (rpc !== undefined)
    addEndpoint(context, { node, kind: "network", ...rpc });
};

export const inspectRouteProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  const key = semanticStaticPropertyName(node.key, node.computed);
  if ((key === "path" || key === "route") && t.isStringLiteral(node.value))
    addEndpoint(context, {
      node,
      kind: "route",
      value: node.value.value,
      mechanism: `property:${key}`,
    });
};

export const inspectRoleProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  if (semanticStaticPropertyName(node.key, node.computed) !== "preload") return;
  if (context.accumulator.mediaElementPreloads.has(node)) return;
  const path = staticPath(node.value);
  if (path === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.roles,
    key: `role\0preload\0${path}`,
    node,
    value: {
      role: "preload",
      path,
      resolution_context: staticPathResolutionContext(node.value),
      mechanism: "property:preload",
      module_key: null,
      location: range(node),
    },
  });
};

const inspectStorageCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const storage =
    receiverFact === "local" ||
    receiverFact === "local-indexed-db" ||
    receiverFact === "local-cache-storage"
      ? undefined
      : receiverFact === "indexed-db"
        ? "indexed-db"
        : receiverFact === "cache-storage"
          ? "cache-storage"
          : storageKind(name);
  if (storage === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.storage,
    key: `storage\0${storage}\0${first ?? ""}`,
    node,
    value: {
      kind: storage,
      name: first ?? null,
      mechanism: `call:${name}`,
      module_key: null,
      location: range(node),
    },
  });
};

export const addReference = (
  context: FindingContext,
  input: ReferenceInput,
): void => {
  const specifier = input.specifier ?? null;
  const reference =
    specifier === null
      ? {
          specifier: null,
          expression: sourceSlice(context.source, input.node),
        }
      : { specifier, expression: null };
  addLocatedFinding(context, {
    collection: context.accumulator.references,
    key: `reference\0${input.kind}\0${reference.specifier ?? reference.expression}`,
    node: input.node,
    value: {
      kind: input.kind,
      ...reference,
      module_key: null,
      location: range(input.node),
    },
  });
};

const addEndpoint = (context: FindingContext, input: EndpointInput): void =>
  addLocatedFinding(context, {
    collection: context.accumulator.endpoints,
    key: `endpoint\0${input.kind}\0${input.value}`,
    node: input.node,
    value: {
      kind: input.kind,
      value: sanitizeEndpointCandidate(input.value),
      mechanism: input.mechanism,
      module_key: null,
      location: range(input.node),
    },
  });

export const addSourceMapDirectives = (
  source: string,
  comments: readonly t.Comment[],
  accumulator: AnalysisAccumulator,
): void => {
  // Read real comment tokens only; quoted text can contain identical markers.
  // Keep both current/legacy line annotations and minifier block annotations.
  for (const comment of comments) {
    const start = comment.start;
    const end = comment.end;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    )
      continue;
    // The parser owns comment boundaries. Exclude only the closing block
    // delimiter; an asterisk elsewhere remains part of the declared URL.
    const commentSource = source.slice(
      start,
      comment.type === "CommentBlock" ? end - 2 : end,
    );
    if (
      !(commentSource.startsWith("//") || commentSource.startsWith("/*")) ||
      !(commentSource[2] === "#" || commentSource[2] === "@")
    )
      continue;
    // Single-class searches avoid regex backtracking over unbounded whitespace
    // or inline URLs, which can exhaust the engine stack on two-byte strings.
    const nameOffset = commentSource.slice(3).search(/\S/u);
    if (nameOffset === -1) continue;
    const nameStart = 3 + nameOffset;
    if (!commentSource.startsWith("sourceMappingURL", nameStart)) continue;
    const nameEnd = nameStart + "sourceMappingURL".length;
    const equalsOffset = commentSource.slice(nameEnd).search(/\S/u);
    if (equalsOffset === -1) continue;
    const equalsStart = nameEnd + equalsOffset;
    if (!commentSource.startsWith("=", equalsStart)) continue;
    const urlOffset = commentSource.slice(equalsStart + 1).search(/\S/u);
    if (urlOffset === -1) continue;
    const declaredStart = equalsStart + 1 + urlOffset;
    const terminator = commentSource.slice(declaredStart).search(/\s/u);
    const declaredEnd =
      terminator === -1 ? commentSource.length : declaredStart + terminator;
    if (declaredEnd === declaredStart) continue;
    const declared = commentSource.slice(declaredStart, declaredEnd);
    const location = rangeForOffsets(source, start, start + declaredEnd);
    addFindingOnce(accumulator, `source-map\0${declared}`, () =>
      accumulator.sourceMaps.push({ declared_url: declared, location }),
    );
  }
};
