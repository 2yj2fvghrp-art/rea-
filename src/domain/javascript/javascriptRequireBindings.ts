import * as t from "@babel/types";

import { analyzeParsedJavaScriptReferences } from "./javascriptSemanticAnalysis.js";
import {
  semanticBindingId,
  semanticScopeId,
} from "./javascriptSemanticState.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";
import type { JavaScriptSemanticReference } from "./javascriptSemanticIr.js";
import {
  isExplicitModuleSourcePath,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

/**
 * Keep calls that resolve either to Node's CommonJS wrapper loader or to a
 * direct ESM `createRequire(import.meta.url)` binding. The shared lexical
 * analyzer supplies binding ownership; this boundary accounts for the two
 * Node loader bindings without evaluating arbitrary values.
 */
export const unshadowedJavaScriptRequireCalls = (
  file: Pick<ParsedJavaScriptSource, "program">,
  sourcePath: string | undefined,
): ReadonlySet<t.Node> =>
  completeSemanticSteps(
    unshadowedJavaScriptRequireCallsSteps(
      file,
      sourcePath,
      analyzeParsedJavaScriptReferences(file),
    ),
  );

interface RequireCallSite {
  readonly node: t.Node;
  readonly reference: JavaScriptSemanticReference | undefined;
  readonly statement: number;
  readonly deferred: boolean;
}

/** Classify loader calls without draining whole-source work inside a visitor. */
export function* unshadowedJavaScriptRequireCallsSteps(
  file: Pick<ParsedJavaScriptSource, "program">,
  sourcePath: string | undefined,
  referenceFacts: readonly JavaScriptSemanticReference[],
): Generator<void, ReadonlySet<t.Node>> {
  const references = new Map<string, JavaScriptSemanticReference>();
  const writeLocations = new Set<string>();
  const programBinding = semanticBindingId(
    semanticScopeId("program", file.program),
    "require",
  );
  let hasRequire = false;
  for (const reference of referenceFacts) {
    yield;
    const key = locationKey(reference.location.start);
    references.set(key, reference);
    if (reference.name !== "require") continue;
    hasRequire = true;
    if (
      reference.role === "write" &&
      (reference.resolution === "unbound" ||
        reference.bindingId === programBinding)
    )
      writeLocations.add(key);
  }
  if (!hasRequire) return new Set();
  const allowsUnbound =
    sourcePath === undefined || !isExplicitModuleSourcePath(sourcePath);
  const createRequireBinding = yield* directCreateRequireBindingSteps(
    file.program,
    references,
  );
  const scan = yield* scanRequireSitesSteps(
    file.program,
    references,
    writeLocations,
  );
  const calls = new Set<t.Node>();
  for (const site of scan.sites) {
    yield;
    const reference = site.reference;
    const loaderIntact =
      !scan.unknownWrite &&
      (scan.firstWrite === null ||
        (!site.deferred && site.statement < scan.firstWrite));
    if (
      (allowsUnbound && loaderIntact && reference?.resolution === "unbound") ||
      (((allowsUnbound && scan.wrapperVar && loaderIntact) ||
        createRequireBinding) &&
        reference?.resolution === "resolved" &&
        reference.bindingId === programBinding)
    )
      calls.add(site.node);
  }
  return calls;
}

const locationKey = (position: {
  readonly line: number;
  readonly column: number;
}): string => `${String(position.line)}:${String(position.column)}`;

function* scanRequireSitesSteps(
  program: t.Program,
  references: ReadonlyMap<string, JavaScriptSemanticReference>,
  writeLocations: ReadonlySet<string>,
): Generator<
  void,
  {
    readonly sites: readonly RequireCallSite[];
    readonly wrapperVar: boolean;
    readonly firstWrite: number | null;
    readonly unknownWrite: boolean;
  }
> {
  const sites: RequireCallSite[] = [];
  let statement = -1;
  let wrapperVar = false;
  let firstWrite: number | null = null;
  let unknownWrite = false;
  const locatedWrites = new Set<string>();
  const writeAt = (node: t.Node, ancestors: readonly t.Node[]): void => {
    if (statement < 0 || deferredExecution(node, ancestors))
      unknownWrite = true;
    else firstWrite = Math.min(firstWrite ?? statement, statement);
  };
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node, parent, readAncestors) => {
      if (parent === program && t.isStatement(node)) statement += 1;
      if (
        t.isIdentifier(node, { name: "require" }) &&
        node.loc !== null &&
        node.loc !== undefined &&
        writeLocations.has(locationKey(node.loc.start))
      ) {
        locatedWrites.add(locationKey(node.loc.start));
        writeAt(node, readAncestors());
      }
      if (
        t.isVariableDeclarator(node) &&
        t.isVariableDeclaration(parent, { kind: "var" }) &&
        Object.hasOwn(t.getBindingIdentifiers(node.id), "require")
      ) {
        const ancestors = readAncestors();
        if (
          !ancestors.some(
            (ancestor) => t.isFunction(ancestor) || t.isStaticBlock(ancestor),
          )
        ) {
          wrapperVar = true;
          if (node.init !== null) writeAt(node, ancestors);
        }
      }
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      const identifier = requireCalleeIdentifier(node.callee);
      const start = identifier?.loc?.start;
      if (start === undefined) return;
      const ancestors = readAncestors();
      if (
        ancestors.some(
          (ancestor) =>
            t.isWithStatement(ancestor) && contains(ancestor.body, node),
        )
      )
        return;
      sites.push({
        node,
        reference: references.get(locationKey(start)),
        statement,
        deferred: deferredExecution(node, ancestors),
      });
    },
  });
  return {
    sites,
    wrapperVar,
    firstWrite,
    unknownWrite: unknownWrite || locatedWrites.size !== writeLocations.size,
  };
}

// Textual order does not establish execution order across a callable or an
// instance initializer. Same-statement writes also remain conservative; only
// a distinct later program statement proves that a write follows this call.
const deferredExecution = (
  node: t.Node,
  ancestors: readonly t.Node[],
): boolean =>
  ancestors.some(
    (ancestor) =>
      t.isFunction(ancestor) ||
      ((t.isClassProperty(ancestor) ||
        t.isClassPrivateProperty(ancestor) ||
        t.isClassAccessorProperty(ancestor)) &&
        !ancestor.static &&
        ancestor.value != null &&
        contains(ancestor.value, node)),
  );

const contains = (container: t.Node, node: t.Node): boolean =>
  typeof container.start === "number" &&
  typeof container.end === "number" &&
  typeof node.start === "number" &&
  typeof node.end === "number" &&
  container.start <= node.start &&
  node.end <= container.end;

function* directCreateRequireBindingSteps(
  program: t.Program,
  references: ReadonlyMap<string, JavaScriptSemanticReference>,
): Generator<void, boolean> {
  const programScope = semanticScopeId("program", program);
  const importedNames = new Set<string>();
  for (const declaration of program.body) {
    yield;
    if (
      !t.isImportDeclaration(declaration) ||
      (declaration.source.value !== "node:module" &&
        declaration.source.value !== "module")
    )
      continue;
    for (const specifier of declaration.specifiers) {
      yield;
      if (
        t.isImportSpecifier(specifier) &&
        t.isIdentifier(specifier.imported, { name: "createRequire" })
      )
        importedNames.add(specifier.local.name);
    }
  }
  if (importedNames.size === 0) return false;
  for (const statement of program.body) {
    yield;
    if (!t.isVariableDeclaration(statement, { kind: "const" })) continue;
    for (const declaration of statement.declarations) {
      yield;
      if (
        !t.isIdentifier(declaration.id, { name: "require" }) ||
        !t.isCallExpression(declaration.init) ||
        !t.isIdentifier(declaration.init.callee) ||
        !importedNames.has(declaration.init.callee.name) ||
        !isImportMetaUrl(declaration.init.arguments[0])
      )
        continue;
      const start = declaration.init.callee.loc?.start;
      if (start === undefined) continue;
      const reference = references.get(locationKey(start));
      if (
        reference?.resolution === "resolved" &&
        reference.bindingId ===
          semanticBindingId(programScope, declaration.init.callee.name)
      )
        return true;
    }
  }
  return false;
}

const isImportMetaUrl = (node: t.Node | undefined): boolean =>
  t.isMemberExpression(node) &&
  !node.computed &&
  t.isIdentifier(node.property, { name: "url" }) &&
  t.isMetaProperty(node.object) &&
  t.isIdentifier(node.object.meta, { name: "import" }) &&
  t.isIdentifier(node.object.property, { name: "meta" });

const requireCalleeIdentifier = (
  callee: t.Node | null | undefined,
): t.Identifier | undefined => {
  if (t.isIdentifier(callee, { name: "require" })) return callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" }) ||
    ((!t.isIdentifier(callee.property) || callee.computed) &&
      !t.isStringLiteral(callee.property))
  )
    return undefined;
  const propertyName = t.isIdentifier(callee.property)
    ? callee.property.name
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  return propertyName === "resolve" || propertyName === "main"
    ? callee.object
    : undefined;
};
