import { createHash } from "node:crypto";

import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import {
  fullName,
  type SignatureTypeName,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataRowCursor,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { readManagedValue } from "./ManagedReaderFailure.js";

const TYPE_REF = 1;
const TYPE_DEF = 2;
const NESTED_CLASS = 41;
/** ResolutionScope tag of a TypeRef that names a nested type's enclosing TypeRef. */
const ENCLOSING_TYPE_REF = 3;

/** One type's own name and the row of its enclosing type, if nested. */
interface TypeLink {
  readonly name: string;
  readonly enclosingRow: number | null;
}

/** Each nested TypeDef row's enclosing row, from the NestedClass table. */
const enclosingTypeDefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): ReadonlyMap<number, number> => {
  const enclosing = new Map<number, number>();
  const rows = layout.table(NESTED_CLASS)?.rowCount ?? 0;
  for (let row = 1; row <= rows; row += 1) {
    const cursor = metadataRowCursor(bytes, layout, NESTED_CLASS, row);
    const nested = cursor.readIndex(layout.tableIndexSize(TYPE_DEF));
    enclosing.set(nested, cursor.readIndex(layout.tableIndexSize(TYPE_DEF)));
  }
  return enclosing;
};

const readTypeReference = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): TypeLink | null => {
  return (
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, TYPE_REF, row);
      const scope = cursor.readIndex(layout.codedIndexSize("ResolutionScope"));
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const namespace = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      return {
        name: fullName(namespace, name),
        enclosingRow: (scope & 3) === ENCLOSING_TYPE_REF ? scope >>> 2 : null,
      };
    }, []) ?? null
  );
};

/** Join a type's name after its enclosing types' names; null on a gap or cycle. */
const nestedName = (
  row: number,
  link: (row: number) => TypeLink | null,
): string | null => {
  const names: string[] = [];
  const seen = new Set<number>();
  for (let current: number | null = row; current !== null;) {
    const step = link(current);
    if (step === null || seen.has(current)) return null;
    seen.add(current);
    names.unshift(step.name);
    current = step.enclosingRow;
  }
  return names.join("/");
};

/**
 * Name signature type operands independently of their metadata rows: a TypeDef
 * or TypeRef by namespace and name, after its enclosing types for a nested
 * type, as in `Outer/Inner`. A TypeSpec, an unreadable row, or cyclic nesting
 * has no name, so its signature has no resolved digest. Each coded index is
 * named and digested once, so repeated operands cost a lookup.
 */
export const signatureTypeNames = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
): SignatureTypeName => {
  let enclosingDefs: ReadonlyMap<number, number> | undefined;
  const definition = (row: number): TypeLink | null => {
    const name = ranges[row - 1]?.fullName ?? null;
    if (name === null) return null;
    enclosingDefs ??= enclosingTypeDefs(bytes, layout);
    return { name, enclosingRow: enclosingDefs.get(row) ?? null };
  };
  const name = (codedIndex: number): string | null => {
    const row = codedIndex >>> 2;
    switch (codedIndex & 3) {
      case 0:
        return nestedName(row, definition);
      case 1:
        return nestedName(row, (current) =>
          readTypeReference(bytes, layout, current),
        );
      default:
        return null;
    }
  };
  const digests = new Map<number, Buffer | null>();
  return (codedIndex) => {
    let digest = digests.get(codedIndex);
    if (digest === undefined) {
      managedDecodeBudget(layout).reserve(256, null);
      const named = name(codedIndex);
      digest =
        named === null ? null : createHash("sha256").update(named).digest();
      digests.set(codedIndex, digest);
    }
    return digest;
  };
};
