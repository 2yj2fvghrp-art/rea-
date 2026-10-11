import { numberValue } from "./CdpCaptureValues.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

interface DomSnapshotNodes {
  readonly nodeTypes: readonly number[];
  readonly nodeNames: readonly number[];
  readonly parents: readonly number[];
  readonly strings: readonly string[];
  readonly attributes: readonly unknown[];
}

interface NamespaceScope {
  readonly bindings: ReadonlyMap<string, string>;
}

interface XmlElementScope {
  readonly svgElement: boolean;
  readonly xlinkHref: string | undefined;
  readonly scope: NamespaceScope;
}

interface DocumentSvgAncestry {
  readonly xml: boolean;
  readonly nodes: DomSnapshotNodes;
  readonly svgContexts: Map<number, boolean>;
  readonly xmlScopes: Map<number, XmlElementScope>;
}

interface DomSvgLink {
  readonly svgElement: boolean;
  readonly xmlDocument: boolean;
  readonly xlinkHref: string | undefined;
}

const EMPTY_SCOPE: NamespaceScope = { bindings: new Map() };

const stringAt = (strings: readonly string[], index: unknown): string => {
  const integer = numberValue(index);
  return integer === undefined ? "" : (strings[Math.trunc(integer)] ?? "");
};

const numberArray = (value: unknown): readonly number[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const number = numberValue(item);
        return number === undefined ? [] : [number];
      })
    : [];

// DOMSnapshot has no namespace URI. HTML documents use uppercase `HTML` and
// the parser's local names. XHTML/XML documents use lowercase `html` (or a
// prefixed root) and keep xmlns declarations as attributes.
const xmlDocument = (nodes: DomSnapshotNodes): boolean => {
  const documentIndex = nodes.nodeTypes.findIndex(
    (nodeType) => Math.trunc(nodeType) === 9,
  );
  if (documentIndex < 0) return false;
  for (let index = 0; index < nodes.nodeTypes.length; index += 1) {
    if (Math.trunc(nodes.nodeTypes[index] ?? 0) !== 1) continue;
    if (Math.trunc(nodes.parents[index] ?? -1) !== documentIndex) continue;
    const name = stringAt(nodes.strings, nodes.nodeNames[index]);
    return name === "html" || name.includes(":");
  }
  return false;
};

export const createDocumentSvgAncestry = (
  nodes: DomSnapshotNodes,
): DocumentSvgAncestry => ({
  xml: xmlDocument(nodes),
  nodes,
  svgContexts: new Map(),
  xmlScopes: new Map(),
});

export const domSvgLink = (
  ancestry: DocumentSvgAncestry,
  index: number,
): DomSvgLink => {
  if (!ancestry.xml) {
    return {
      svgElement: elementInSvgContext(
        index,
        ancestry.nodes,
        ancestry.svgContexts,
      ),
      xmlDocument: false,
      xlinkHref: undefined,
    };
  }
  const resolved = xmlElementScope(index, ancestry.nodes, ancestry.xmlScopes);
  return {
    svgElement: resolved.svgElement,
    xmlDocument: true,
    xlinkHref: resolved.xlinkHref,
  };
};

// Chrome's HTML parser records SVG local names (`svg`, `foreignObject`).
// Descendants of foreignObject are HTML until a nested `svg`.
const elementInSvgContext = (
  index: number,
  nodes: DomSnapshotNodes,
  contexts: Map<number, boolean>,
): boolean => {
  let current = index;
  const seen = new Set<number>();
  let inSvg = false;
  while (
    current >= 0 &&
    current < nodes.nodeNames.length &&
    !seen.has(current)
  ) {
    const cached = contexts.get(current);
    if (cached !== undefined) {
      inSvg = cached;
      break;
    }
    seen.add(current);
    if (stringAt(nodes.strings, nodes.nodeNames[current]) === "svg") {
      inSvg = true;
      break;
    }
    const parent = Math.trunc(nodes.parents[current] ?? -1);
    if (parent < 0 || parent === current) break;
    if (stringAt(nodes.strings, nodes.nodeNames[parent]) === "foreignObject")
      break;
    current = parent;
  }
  // Cache the entire examined chain, including forward references and cycles,
  // so shared ancestors are examined once per document.
  for (const node of seen) contexts.set(node, inSvg);
  return inSvg;
};

const xmlElementScope = (
  index: number,
  nodes: DomSnapshotNodes,
  scopes: Map<number, XmlElementScope>,
): XmlElementScope => {
  const cached = scopes.get(index);
  if (cached !== undefined) return cached;
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = index;
  while (
    current >= 0 &&
    current < nodes.nodeNames.length &&
    !seen.has(current)
  ) {
    if (scopes.has(current)) break;
    seen.add(current);
    chain.push(current);
    const parent = Math.trunc(nodes.parents[current] ?? -1);
    if (parent < 0 || parent === current || parent >= nodes.nodeNames.length) {
      current = -1;
      break;
    }
    current = parent;
  }
  if (current >= 0 && seen.has(current)) return cacheUnresolved(chain, scopes);
  return cacheChain(chain, parentScope(current, scopes), nodes, scopes);
};

const cacheUnresolved = (
  chain: readonly number[],
  scopes: Map<number, XmlElementScope>,
): XmlElementScope => {
  const unresolved: XmlElementScope = {
    svgElement: false,
    xlinkHref: undefined,
    scope: EMPTY_SCOPE,
  };
  for (const node of chain) scopes.set(node, unresolved);
  return unresolved;
};

const parentScope = (
  current: number,
  scopes: Map<number, XmlElementScope>,
): NamespaceScope =>
  current >= 0 ? (scopes.get(current)?.scope ?? EMPTY_SCOPE) : EMPTY_SCOPE;

const cacheChain = (
  chain: readonly number[],
  inherited: NamespaceScope,
  nodes: DomSnapshotNodes,
  scopes: Map<number, XmlElementScope>,
): XmlElementScope => {
  let scope = inherited;
  let resolved: XmlElementScope = {
    svgElement: false,
    xlinkHref: undefined,
    scope,
  };
  for (let cursor = chain.length - 1; cursor >= 0; cursor -= 1) {
    const node = chain[cursor] ?? -1;
    const attributes = numberArray(nodes.attributes[node]);
    scope = scopeWithDeclarations(scope, attributes, nodes.strings);
    const svgElement =
      Math.trunc(nodes.nodeTypes[node] ?? 0) === 1 &&
      elementNamespace(
        stringAt(nodes.strings, nodes.nodeNames[node]),
        scope,
      ) === SVG_NAMESPACE;
    resolved = {
      svgElement,
      xlinkHref: svgElement
        ? xlinkHrefValue(attributes, nodes.strings, scope)
        : undefined,
      scope,
    };
    scopes.set(node, resolved);
  }
  return resolved;
};

const scopeWithDeclarations = (
  parent: NamespaceScope,
  attributes: readonly number[],
  strings: readonly string[],
): NamespaceScope => {
  let bindings: Map<string, string> | undefined;
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const prefix = xmlnsPrefix(stringAt(strings, attributes[index]));
    if (prefix === undefined || seen.has(prefix)) continue;
    seen.add(prefix);
    bindings ??= new Map(parent.bindings);
    const value = stringAt(strings, attributes[index + 1]);
    if (value.length === 0) bindings.delete(prefix);
    else bindings.set(prefix, value);
  }
  return bindings === undefined ? parent : { bindings };
};

const xmlnsPrefix = (name: string): string | undefined => {
  if (name === "xmlns") return "";
  if (!name.startsWith("xmlns:")) return undefined;
  const prefix = name.slice("xmlns:".length);
  if (prefix.length === 0 || prefix === "xmlns" || prefix.includes(":"))
    return undefined;
  return prefix;
};

const elementNamespace = (nodeName: string, scope: NamespaceScope): string => {
  const colon = nodeName.indexOf(":");
  if (colon < 0) return scope.bindings.get("") ?? "";
  const prefix = nodeName.slice(0, colon);
  const local = nodeName.slice(colon + 1);
  if (
    prefix.length === 0 ||
    local.length === 0 ||
    local.includes(":") ||
    prefix === "xmlns"
  )
    return "";
  return scope.bindings.get(prefix) ?? "";
};

// First prefixed href bound to the XLink namespace. Duplicate names keep the
// earlier value. Plain href is applied by the caller and wins even when empty.
const xlinkHrefValue = (
  attributes: readonly number[],
  strings: readonly string[],
  scope: NamespaceScope,
): string | undefined => {
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = stringAt(strings, attributes[index]);
    if (seen.has(name)) continue;
    seen.add(name);
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1);
    if (local !== "href" || scope.bindings.get(prefix) !== XLINK_NAMESPACE)
      continue;
    return stringAt(strings, attributes[index + 1]);
  }
  return undefined;
};
