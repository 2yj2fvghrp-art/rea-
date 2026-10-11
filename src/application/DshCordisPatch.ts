import { isMap, isSeq } from "yaml";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from "yaml";

import type {
  ClientConfigurationDocument,
  ClientConfigurationFormat,
} from "./ClientConfigurationDocument.js";

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

const isInsertEntry = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Reflect.get(value, "id") === DSH_ENTRY_ID;

const parsePatchList = (text: string): readonly unknown[] => {
  if (text.replace(/^\uFEFF/, "").trim() === "") return [];
  const value: unknown = parseYaml(text);
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
  return {
    document: { [PATCHES_KEY]: [...patches] },
    servers: config === undefined ? {} : { rea: config },
    serversPath: [PATCHES_KEY],
    dialect: "dsh",
    legacyServers: {},
  };
};

/**
 * The effective config of the REA entry under Cordis patch semantics: patches
 * apply in order, an insert replaces the row named by id, and a later direct
 * `{ id, config }` operation replaces that row's whole config. The entry reads
 * back only when the winning writer left the canonical Harness MCP client
 * package as its name; a wrong or missing package name reads back as absent so
 * the next setup rewrites exactly one canonical entry.
 */
const dshEntryConfig = (
  patches: readonly unknown[],
): Record<string, unknown> | undefined => {
  let name: unknown;
  let config: Record<string, unknown> | undefined;
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
        name = Reflect.get(entry, "name");
        config = configOf(Reflect.get(entry, "config"));
      }
      continue;
    }
    // A direct patch to the row replaces its config and, when present, its
    // name; the repository verifier uses these operations natively.
    if (Reflect.get(op, "id") !== DSH_ENTRY_ID) continue;
    const opName = Reflect.get(op, "name");
    if (opName !== undefined) name = opName;
    if (Reflect.has(op as object, "config"))
      config = configOf(Reflect.get(op, "config"));
  }
  return name === DSH_CLIENT_PACKAGE ? config : undefined;
};

/**
 * Return the document with the REA entry upserted into its patch list. The
 * first id-matching insert is replaced in place, later duplicates and direct
 * patches to the entry are dropped so exactly one canonical row remains, and
 * a fresh insert operation is appended when nothing matched.
 */
export const withDshServer = (
  parsed: ClientConfigurationDocument,
  desired: Record<string, unknown>,
): Record<string, unknown> => {
  let replaced = false;
  const patches = (parsed.document[PATCHES_KEY] as readonly unknown[]).flatMap(
    (op) => {
      if (typeof op !== "object" || op === null || Array.isArray(op))
        return [op];
      const inserted = Reflect.get(op, "insert");
      if (Array.isArray(inserted)) {
        let seen = false;
        const next = inserted.flatMap((entry) => {
          if (!isInsertEntry(entry)) return [entry];
          // Replace the first matching row; collapse any later duplicates.
          if (seen) return [];
          seen = true;
          return [
            {
              ...entry,
              name: DSH_CLIENT_PACKAGE,
              config: { ...desired },
            } as unknown,
          ];
        });
        if (!seen) return [op];
        replaced = true;
        if (next.length === 0) return [];
        return [{ ...(op as Record<string, unknown>), insert: next }];
      }
      // Direct patches to the REA row are superseded by the rewritten entry.
      if (Reflect.get(op, "id") === DSH_ENTRY_ID) {
        replaced = true;
        return [];
      }
      return [op];
    },
  );
  if (!replaced)
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

/**
 * Serialize the patch list, editing an existing file's YAML document in place
 * so user comments and formatting survive an REA registration update. The REA
 * entry is removed wherever its insert op carries it, then re-appended with
 * the current config; emptied insert operations are dropped.
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
  const root = yamlDocument.contents;
  if (!isSeq(root)) {
    // The file was a patch list when parsed; a root that no longer is cannot
    // be edited in place, so a fresh patch list is emitted instead.
    return `${stringifyYaml(freshPatchList())}`;
  }
  type PatchItem = (typeof root.items)[number];
  root.items = root.items.flatMap((item): PatchItem[] => {
    if (!isMap(item)) return [item];
    const insert = item.get("insert");
    if (!isSeq(insert)) {
      // Direct patches to the REA row are superseded by the rewritten entry
      // and would otherwise override it again at their position.
      return (item.get("id") as unknown) === DSH_ENTRY_ID ? [] : [item];
    }
    // yaml unwraps scalar members in get(); the cast keeps the comparison honest.
    const withoutRea = insert.items.filter(
      (entry) =>
        !(isMap(entry) && (entry.get("id") as unknown) === DSH_ENTRY_ID),
    );
    if (withoutRea.length === insert.items.length) return [item];
    // Edit this operation's insert list in place, preserving its other keys.
    insert.items = withoutRea;
    return withoutRea.length === 0 ? [] : [item];
  });
  if (desired !== undefined) {
    const appended = yamlDocument.createNode({
      insert: [{ id: DSH_ENTRY_ID, name: DSH_CLIENT_PACKAGE, config: desired }],
    });
    root.items.push(appended as unknown as (typeof root.items)[number]);
  }
  return yamlDocument.toString({ lineWidth: 0 });
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

/** Type-only anchor keeping the format union honest for future callers. */
export type DshConfigurationFormat = Extract<ClientConfigurationFormat, "dsh">;
