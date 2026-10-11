import { isAlias, isMap, isScalar, isSeq } from "yaml";
import type { Document, YAMLMap } from "yaml";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from "yaml";

import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";

/**
 * DeepSeek Harness registers MCP clients through a Cordis YAML patch sequence
 * rather than a server table: each file is a list of operations, and an
 * `insert` operation carries entries identified by `id`. REA owns exactly one
 * entry id and never touches unrelated patches.
 */
export const DSH_ENTRY_ID = "rea-mcp";
/** The Harness MCP client package every REA registration loads. */
export const DSH_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** Document key holding the patch list inside the generic client machinery. */
const PATCHES_KEY = "dshPatches";
/**
 * Keys REA owns inside a Harness registration config; the rest is caller
 * territory and keeps its YAML node, including Cordis `!!js` tags.
 * `duplicate` is a read-side projection, never a field Harness loads.
 */
const DSH_OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "serverName",
  "transport",
  "command",
  "args",
  "env",
  "disabled",
  "package",
  "duplicate",
]);

/**
 * Cordis evaluates `!!js` expressions. The value parser keeps the source text
 * so a refresh can compare it, and the document parser keeps the tag itself.
 */
const CORDIS_JAVASCRIPT_TAG = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value: string): string => value,
};

const isInsertEntry = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Reflect.get(value, "id") === DSH_ENTRY_ID;

const parsePatchList = (text: string): readonly unknown[] => {
  if (text.replace(/^\uFEFF/, "").trim() === "") return [];
  const value: unknown = parseYaml(text, {
    customTags: [CORDIS_JAVASCRIPT_TAG],
  });
  // A comment-only file has no document value. Cordis loads that as no patches,
  // the same as an empty file, instead of a malformed root.
  if (value === null) return [];
  if (!Array.isArray(value))
    throw new SyntaxError(
      "DeepSeek Harness cordis.patch.yml must be a YAML list of patch operations",
    );
  return value;
};

/**
 * Parse the home patch into the shared client-document shape: the patch list
 * is retained verbatim under `dshPatches`, and the REA entry's `config`
 * becomes the `rea` server record the setup and doctor machinery reads.
 */
export const parseDshCordisDocument = (
  text: string,
): ClientConfigurationDocument => {
  const patches = parsePatchList(text);
  const config = dshEntryConfig(patches);
  const expressions = cordisEnvironmentExpressions(text);
  return {
    document: { [PATCHES_KEY]: [...patches] },
    servers: config === undefined ? {} : { rea: config },
    serversPath: [PATCHES_KEY],
    dialect: "dsh",
    legacyServers: {},
    ...(expressions.size === 0
      ? {}
      : { cordisEnvironmentExpressions: expressions }),
  };
};

/**
 * Whether the patch list contains the REA entry id, including a direct patch
 * that never established a row. Uninstall owns that id even when the projected
 * server is absent or its launcher is not the canonical command.
 */
export const dshDocumentCarriesEntry = (
  document: Record<string, unknown>,
): boolean => {
  const patches = document[PATCHES_KEY];
  if (!Array.isArray(patches)) return false;
  return patches.some((op) => {
    if (typeof op !== "object" || op === null || Array.isArray(op))
      return false;
    if (Reflect.get(op, "id") === DSH_ENTRY_ID) return true;
    const inserted = Reflect.get(op, "insert");
    return (
      Array.isArray(inserted) && inserted.some((entry) => isInsertEntry(entry))
    );
  });
};

/**
 * The effective config of the REA entry under Cordis patch semantics: patches
 * apply in order, an insert replaces the row named by id, and a later direct
 * `{ id, config }` operation replaces that row's whole config only once an
 * insertion established the row. The entry reads back as a server record even
 * when the winning writer left a wrong or missing package name, so a repair
 * preserves the row's configured environment; the foreign name is projected
 * into the record so alignment and comparison treat the row as stale. More
 * than one id-matching insertion is projected the same way: an aligned
 * duplicate still has to be collapsed to the single canonical row.
 */
const dshEntryConfig = (
  patches: readonly unknown[],
): Record<string, unknown> | undefined => {
  let name: unknown;
  let config: Record<string, unknown> | undefined;
  let disabled: unknown;
  let established = false;
  let matches = 0;
  const configOf = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  for (const op of patches) {
    if (typeof op !== "object" || op === null || Array.isArray(op)) continue;
    const inserted = Reflect.get(op, "insert");
    if (Array.isArray(inserted)) {
      for (const entry of inserted) {
        if (!isInsertEntry(entry)) continue;
        matches += 1;
        name = Reflect.get(entry, "name");
        config = configOf(Reflect.get(entry, "config"));
        disabled = Reflect.get(entry, "disabled");
        established = true;
      }
      continue;
    }
    // A direct patch targets a row an insertion must have established; a
    // dangling operation with no row configures nothing Harness can load.
    if (Reflect.get(op, "id") !== DSH_ENTRY_ID) continue;
    if (!established) continue;
    const opName = Reflect.get(op, "name");
    if (opName !== undefined) name = opName;
    if (Reflect.has(op as object, "config"))
      config = configOf(Reflect.get(op, "config"));
    if (Reflect.has(op as object, "disabled"))
      disabled = Reflect.get(op, "disabled");
  }
  if (!established || config === undefined) return undefined;
  // Cordis keeps activation beside the config. A literal `true` never loads
  // REA tools, and any other explicit state (including a `!!js` expression)
  // can evaluate to disabled, so both project as stale. Only an omitted
  // field or boolean `false` is an enabled row. A foreign package name and a
  // repeated insertion are projected the same way instead of hiding the
  // row's config. A caller key named `duplicate` is not that projection;
  // only an extra insertion sets it.
  const configFields = { ...config };
  delete configFields.duplicate;
  const activationSuppressed = disabled !== undefined && disabled !== false;
  return {
    ...configFields,
    ...(activationSuppressed ? { disabled: true } : {}),
    ...(name === DSH_CLIENT_PACKAGE
      ? {}
      : {
          package:
            typeof name === "string" ? name : "non-string package declaration",
        }),
    ...(matches > 1 ? { duplicate: true } : {}),
  };
};

/** The canonical row REA writes for its entry, minus Cordis activation state. */
const canonicalDshEntry = (
  entry: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> => {
  const { disabled: _superseded, ...envelope } = entry;
  return { ...envelope, name: DSH_CLIENT_PACKAGE, config: { ...desired } };
};

/**
 * Return the document with the REA entry upserted into its patch list. The
 * first id-matching insert is replaced in place, later duplicates and direct
 * patches to the entry are dropped so exactly one canonical row remains, and
 * a fresh insert operation is appended when no insertion carried the entry;
 * removing a direct-only patch does not count as carrying it.
 */
export const withDshServer = (
  parsed: ClientConfigurationDocument,
  desired: Record<string, unknown>,
): Record<string, unknown> => {
  let carriedByInsert = false;
  const patches = (parsed.document[PATCHES_KEY] as readonly unknown[]).flatMap(
    (op) => {
      if (typeof op !== "object" || op === null || Array.isArray(op))
        return [op];
      const inserted = Reflect.get(op, "insert");
      if (Array.isArray(inserted)) {
        let replacedHere = false;
        const next = inserted.flatMap((entry) => {
          if (!isInsertEntry(entry)) return [entry];
          // Keep the first carrying operation in place; collapse the rest.
          if (carriedByInsert || replacedHere) return [];
          replacedHere = true;
          carriedByInsert = true;
          return [canonicalDshEntry(entry as Record<string, unknown>, desired)];
        });
        if (!replacedHere && next.length === inserted.length) return [op];
        return next.length === 0
          ? []
          : [{ ...(op as Record<string, unknown>), insert: next }];
      }
      // Direct patches to the REA row are superseded by the rewritten entry.
      if (Reflect.get(op, "id") === DSH_ENTRY_ID) return [];
      return [op];
    },
  );
  if (!carriedByInsert)
    patches.push({
      insert: [
        { id: DSH_ENTRY_ID, name: DSH_CLIENT_PACKAGE, config: { ...desired } },
      ],
    });
  return { ...parsed.document, [PATCHES_KEY]: patches };
};

/**
 * Return the document with every REA entry removed: entries inside insert
 * operations, direct patches to the entry, and insert operations that hold
 * nothing else after removal.
 */
export const removeDshServer = (
  parsed: ClientConfigurationDocument,
): Record<string, unknown> => {
  const patches = (parsed.document[PATCHES_KEY] as readonly unknown[])
    .map((op) => {
      if (typeof op !== "object" || op === null || Array.isArray(op)) return op;
      const inserted = Reflect.get(op, "insert");
      if (!Array.isArray(inserted)) return op;
      return {
        ...(op as Record<string, unknown>),
        insert: inserted.filter((entry) => !isInsertEntry(entry)),
      };
    })
    .filter((op) => {
      if (typeof op !== "object" || op === null || Array.isArray(op))
        return true;
      // A direct patch to the REA row goes away with the entry.
      if (Reflect.get(op, "id") === DSH_ENTRY_ID) return false;
      const inserted = Reflect.get(op, "insert");
      return !(
        Array.isArray(inserted) &&
        inserted.every((entry) => !isInsertEntry(entry)) &&
        inserted.length === 0
      );
    });
  return { ...parsed.document, [PATCHES_KEY]: patches };
};

/** String keys of a YAML map, ignoring non-string keys. */
const yamlMapStringKeys = (
  map: YAMLMap<unknown, unknown>,
): readonly string[] => {
  const keys: string[] = [];
  for (const pair of map.items) {
    const key = pair.key;
    if (typeof key === "string") keys.push(key);
    else if (isScalar(key) && typeof key.value === "string")
      keys.push(key.value);
  }
  return keys;
};

/**
 * The config node Cordis actually loads: the last insertion's config, then any
 * later direct `{ id, config }` replacement. Earlier direct patches, before an
 * insertion exists, do not establish a row.
 */
const dshWinningConfigNode = (
  items: readonly unknown[],
  yamlDocument: Document,
): unknown => {
  let established = false;
  let winning: unknown;
  for (const raw of items) {
    const item = isAlias(raw) ? (nodeMap(raw, yamlDocument) ?? raw) : raw;
    if (!isMap(item)) continue;
    const insertNode = item.get("insert", true);
    const insert = isAlias(insertNode)
      ? insertNode.resolve(yamlDocument)
      : insertNode;
    if (isSeq(insert)) {
      for (const entry of insert.items) {
        const entryMap = nodeMap(entry, yamlDocument);
        if (
          entryMap === undefined ||
          mapEntryId(entryMap, yamlDocument) !== DSH_ENTRY_ID
        )
          continue;
        established = true;
        winning = nodeMap(entryMap.get("config", true), yamlDocument);
      }
      continue;
    }
    if (
      !established ||
      mapEntryId(item, yamlDocument) !== DSH_ENTRY_ID ||
      !item.has("config")
    )
      continue;
    winning = nodeMap(item.get("config", true), yamlDocument);
  }
  return winning;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Update `env` in place. An entry whose scalar still equals the desired string
 * keeps its node, so a Cordis `!!js` tag survives a launcher repair. A real
 * override replaces only that entry.
 */
const applyDshEnvConfig = (
  yamlDocument: Document,
  config: YAMLMap<unknown, unknown>,
  desiredEnv: unknown,
): void => {
  if (!isPlainRecord(desiredEnv)) {
    config.set("env", yamlDocument.createNode(desiredEnv));
    return;
  }
  const envNode: unknown = config.get("env", true);
  let existing = isAlias(envNode) ? envNode.resolve(yamlDocument) : envNode;
  // `env: *rea-env` shares the anchored map. Clone before editing so the
  // active row keeps tagged values without rewriting the anchor in place.
  if (isAlias(envNode) && isMap(existing)) {
    const cloned = existing.clone();
    if (isMap(cloned)) {
      config.set("env", cloned as never);
      existing = cloned;
    }
  }
  if (!isMap(existing)) {
    config.set("env", yamlDocument.createNode(desiredEnv));
    return;
  }
  const retained = new Set(Object.keys(desiredEnv));
  for (const key of yamlMapStringKeys(existing))
    if (!retained.has(key)) existing.delete(key);
  for (const [key, value] of Object.entries(desiredEnv)) {
    const current = existing.get(key, true);
    const scalar = isAlias(current) ? current.resolve(yamlDocument) : current;
    // An alias of an unchanged tagged scalar stays, so `!!js` on the anchor
    // is still what Harness evaluates.
    if (isScalar(scalar) && scalar.value === value) continue;
    existing.set(key, yamlDocument.createNode(value));
  }
};

/**
 * Overlay REA-owned keys on the winning config node. Caller keys already on
 * that node keep their AST, so a Cordis tag such as `!!js` survives a refresh.
 * Environment values that were not overridden keep their nodes too. A winning
 * node that lives on a later patch is cloned onto the kept entry before that
 * patch is removed.
 */
const JAVASCRIPT_TAG_NAME = "tag:yaml.org,2002:js";

/**
 * Environment keys whose winning scalar is a Cordis expression. The value
 * parser keeps only the source text, so this scan is what stops that text
 * from being checked as a literal REA path.
 */
const cordisEnvironmentExpressions = (text: string): ReadonlySet<string> => {
  const yamlDocument = parseYamlDocument(text, { logLevel: "silent" });
  const root = yamlDocument.contents;
  if (!isSeq(root)) return new Set();
  const winning = dshWinningConfigNode(root.items, yamlDocument);
  if (!isMap(winning)) return new Set();
  const envNode: unknown = winning.get("env", true);
  const env = isAlias(envNode) ? envNode.resolve(yamlDocument) : envNode;
  if (!isMap(env)) return new Set();
  const keys = new Set<string>();
  for (const key of yamlMapStringKeys(env)) {
    const node: unknown = env.get(key, true);
    const scalar = isAlias(node) ? node.resolve(yamlDocument) : node;
    if (isScalar(scalar) && scalar.tag === JAVASCRIPT_TAG_NAME) keys.add(key);
  }
  return keys;
};

/** The config node to edit: the kept entry's own node, or a clone of a later or aliased winner. */
const registrationConfigNode = (
  yamlDocument: Document,
  entryMap: YAMLMap<unknown, unknown>,
  winningConfig: unknown,
): YAMLMap<unknown, unknown> | undefined => {
  const winning = nodeMap(winningConfig, yamlDocument);
  if (winning === undefined) return undefined;
  if (entryMap.get("config") === winning) return winning;
  const cloned = winning.clone();
  return isMap(cloned) ? cloned : undefined;
};

const applyDshRegistrationConfig = (
  yamlDocument: Document,
  entryMap: YAMLMap<unknown, unknown>,
  desired: Record<string, unknown>,
  winningConfig: unknown,
): void => {
  const config = registrationConfigNode(yamlDocument, entryMap, winningConfig);
  if (config === undefined) {
    entryMap.set("config", yamlDocument.createNode(desired));
    return;
  }
  if (entryMap.get("config") !== config) entryMap.set("config", config);
  const retained = new Set(Object.keys(desired));
  for (const key of yamlMapStringKeys(config))
    if (!retained.has(key)) config.delete(key);
  for (const key of DSH_OWNED_CONFIG_KEYS) {
    if (!Object.hasOwn(desired, key)) continue;
    if (key === "env") {
      applyDshEnvConfig(yamlDocument, config, desired.env);
      continue;
    }
    config.set(key, yamlDocument.createNode(desired[key]));
  }
  for (const [key, value] of Object.entries(desired)) {
    if (DSH_OWNED_CONFIG_KEYS.has(key) || config.has(key)) continue;
    config.set(key, yamlDocument.createNode(value));
  }
};

/**
 * Serialize the patch list, editing an existing file's YAML document in place
 * so user comments, formatting, and operation scope survive a registration
 * update: the first insertion carrying the REA entry keeps its position and
 * neighbor entries (a grouped insert stays grouped), the entry node itself is
 * rewritten in place, later carrying insertions and direct REA patches
 * collapse away, and a fresh root insertion is appended only when no
 * insertion carried the entry. Caller-owned config nodes, including Cordis
 * `!!js` tags, stay on the winning config; only REA-owned keys are replaced.
 * Environment entries keep their tags unless the value actually changed. A
 * comment-only file is an empty patch list, and its comments stay when the
 * registration is appended. An alias that repeats an owned insertion is
 * collapsed; aliases to other patches stay.
 */
export const serializeDshDocument = (
  document: Record<string, unknown>,
  originalText: string | undefined,
): string => {
  const desired = dshEntryConfig(document[PATCHES_KEY] as readonly unknown[]);
  const freshPatchList = (): readonly unknown[] =>
    desired === undefined
      ? []
      : [
          {
            insert: [
              { id: DSH_ENTRY_ID, name: DSH_CLIENT_PACKAGE, config: desired },
            ],
          },
        ];
  if (
    originalText === undefined ||
    originalText.replace(/^\uFEFF/, "").trim() === ""
  )
    return `${stringifyYaml(freshPatchList())}`;
  const yamlDocument = parseYamlDocument(originalText);
  if (yamlDocument.contents === null) {
    // No document value: comments only. Leave the file untouched when there
    // is nothing to write; otherwise start a sequence on this document so
    // those comments survive the appended registration.
    if (desired === undefined)
      return originalText.endsWith("\n") ? originalText : `${originalText}\n`;
    const empty = parseYamlDocument("[]\n");
    if (isSeq(empty.contents)) yamlDocument.contents = empty.contents;
  }
  const root = yamlDocument.contents;
  if (!isSeq(root)) {
    // The file was a patch list when parsed; a root that no longer is cannot
    // be edited in place, so a fresh patch list is emitted instead.
    return `${stringifyYaml(freshPatchList())}`;
  }
  const winningConfig = dshWinningConfigNode(root.items, yamlDocument);
  // Record insert aliases that carry REA before any edit empties their
  // anchor. Uninstall removes the anchored row first; the later alias must
  // still be dropped or serialization keeps a dangling alias and restores.
  const ownedInsertAliases = new Set<unknown>();
  const ownedRootAliases = new Set<unknown>();
  for (const candidate of root.items) {
    if (isAlias(candidate) && aliasOwnsReaEntry(candidate, yamlDocument))
      ownedRootAliases.add(candidate);
    if (!isMap(candidate)) continue;
    const candidateOperation = candidate as unknown as YAMLMap<
      unknown,
      unknown
    >;
    const candidateInsert: unknown = candidateOperation.get("insert", true);
    if (!isAlias(candidateInsert)) continue;
    const resolved = candidateInsert.resolve(yamlDocument);
    if (
      isSeq(resolved) &&
      resolved.items.some((entry) => entryOwnsRea(entry, yamlDocument))
    )
      ownedInsertAliases.add(candidateInsert);
  }
  let carried = false;
  type PatchItem = (typeof root.items)[number];
  root.items = root.items.flatMap((item): PatchItem[] => {
    if (isAlias(item))
      return ownedRootAliases.has(item) || aliasOwnsReaEntry(item, yamlDocument)
        ? []
        : [item];
    if (!isMap(item)) return [item];
    // Seq members type as node-keyed maps; alias values need the loose view.
    const operation = item as unknown as YAMLMap<unknown, unknown>;
    const insertNode: unknown = operation.get("insert", true);
    // `insert: *rows` is an alias of another operation's list. Editing the
    // anchored list and keeping the alias would still load the row twice.
    let insert: unknown = insertNode;
    if (isAlias(insertNode)) {
      const resolved = insertNode.resolve(yamlDocument);
      const carriesRea =
        ownedInsertAliases.has(insertNode) ||
        (isSeq(resolved) &&
          resolved.items.some((entry) => entryOwnsRea(entry, yamlDocument)));
      if (!carriesRea) return [item];
      // The list already belongs to another insert operation. Dropping this
      // alias avoids loading that list twice. A list anchored outside any
      // insert is copied so its unrelated rows stay in this operation.
      const anchoredOnAnotherInsert = root.items.some((other) => {
        if (other === item || !isMap(other)) return false;
        const otherOperation = other as unknown as YAMLMap<unknown, unknown>;
        return (otherOperation.get("insert", true) as unknown) === resolved;
      });
      if (anchoredOnAnotherInsert || !isSeq(resolved)) return [];
      const cloned = resolved.clone();
      if (!isSeq(cloned)) return [item];
      operation.set("insert", cloned as never);
      insert = cloned;
    }
    if (!isSeq(insert)) {
      // Direct patches to the REA row are superseded by the rewritten entry
      // and would otherwise override it again at their position.
      return mapEntryId(operation, yamlDocument) === DSH_ENTRY_ID ? [] : [item];
    }
    const carrying = insert.items
      .map((entry, index) => (entryOwnsRea(entry, yamlDocument) ? index : -1))
      .filter((index) => index >= 0);
    if (carrying.length === 0) return [item];
    if (carried) {
      removeSeqItems(insert, carrying);
      return insert.items.length === 0 ? [] : [item];
    }
    const first = carrying[0] as number;
    let entry: unknown = insert.items[first];
    // The only owned member may be an alias of an external entry. Copy that
    // map into the list so the refresh can keep its Cordis tags.
    if (isAlias(entry)) {
      const resolved = entry.resolve(yamlDocument);
      const cloned = isMap(resolved) ? resolved.clone() : undefined;
      if (!isMap(cloned)) return [item];
      insert.items[first] = cloned as never;
      entry = cloned;
    }
    carried = true;
    for (const index of carrying.slice(1).reverse())
      insert.items.splice(index, 1);
    if (isMap(entry)) {
      if (desired === undefined) {
        insert.items.splice(carrying[0] as number, 1);
        return insert.items.length === 0 ? [] : [item];
      }
      // Seq members type as node-keyed maps; scalar keys need the loose view.
      const entryMap = entry as unknown as YAMLMap<unknown, unknown>;
      entryMap.set("name", yamlDocument.createNode(DSH_CLIENT_PACKAGE));
      applyDshRegistrationConfig(
        yamlDocument,
        entryMap,
        desired,
        winningConfig,
      );
      // Setup registers an enabled row; Cordis activation is REA-owned here.
      entryMap.delete("disabled");
    }
    return [item];
  });
  if (!carried && desired !== undefined) {
    const appended = yamlDocument.createNode({
      insert: [{ id: DSH_ENTRY_ID, name: DSH_CLIENT_PACKAGE, config: desired }],
    });
    root.items.push(appended as unknown as (typeof root.items)[number]);
  }
  return yamlDocument.toString({ lineWidth: 0 });
};

const nodeMap = (
  node: unknown,
  yamlDocument: Document,
): YAMLMap<unknown, unknown> | undefined => {
  if (isAlias(node)) {
    const resolved = node.resolve(yamlDocument);
    return isMap(resolved) ? resolved : undefined;
  }
  return isMap(node) ? node : undefined;
};

/** Entry id, following an alias such as `id: *entry-id`. */
const mapEntryId = (
  map: YAMLMap<unknown, unknown>,
  yamlDocument: Document,
): unknown => {
  const id = map.get("id", true);
  if (isAlias(id)) {
    const resolved = id.resolve(yamlDocument);
    return isScalar(resolved) ? resolved.value : resolved;
  }
  return isScalar(id) ? id.value : id;
};

/** An alias of an insertion or direct patch that carries the REA entry id. */
const aliasOwnsReaEntry = (node: unknown, yamlDocument: Document): boolean => {
  if (!isAlias(node)) return false;
  const map = nodeMap(node, yamlDocument);
  if (map === undefined) return false;
  if (mapEntryId(map, yamlDocument) === DSH_ENTRY_ID) return true;
  const insert = map.get("insert");
  return (
    isSeq(insert) &&
    insert.items.some((entry) => entryOwnsRea(entry, yamlDocument))
  );
};

const entryOwnsRea = (node: unknown, yamlDocument: Document): boolean => {
  const map = nodeMap(node, yamlDocument);
  return map !== undefined && mapEntryId(map, yamlDocument) === DSH_ENTRY_ID;
};

const removeSeqItems = (
  sequence: { items: unknown[] },
  indexes: readonly number[],
): void => {
  for (const index of [...indexes].reverse()) sequence.items.splice(index, 1);
};

/** Registration entry config shape for the Harness MCP client. */
export const dshClientRegistrationEntry = (
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Record<string, unknown> => {
  const [executable = "rea", ...args] = command;
  return {
    serverName: "rea",
    transport: "stdio",
    command: executable,
    args,
    ...(Object.keys(environment).length === 0
      ? {}
      : { env: { ...environment } }),
  };
};

/**
 * Keep a caller's non-REA config fields, such as the working directory the
 * native verifier sets, across a registration refresh; REA-owned keys are
 * regenerated, never inherited.
 */
export const dshPreservedConfigFields = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const preserved: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>))
    if (!DSH_OWNED_CONFIG_KEYS.has(key)) preserved[key] = field;
  return preserved;
};
