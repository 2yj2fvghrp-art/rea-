import {
  managedFailure,
  ManagedReaderFailure,
  readManagedValue,
} from "./ManagedReaderFailure.js";
import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataCodedToken,
  metadataCodedTokenInvalidReason,
  metadataToken,
  readMetadataString,
  sha256Bytes,
} from "./ManagedMetadataHeaps.js";
import {
  managedDecodeBudget,
  managedJsonStringBytes,
} from "./ManagedDecodeBudget.js";
import { readAssemblyReference } from "./ManagedMetadataInventoryRows.js";

export type ManagedType = ManagedMemberInspection["types"][number];
export type ManagedExportedType =
  ManagedMemberInspection["exported_types"][number];
export type ManagedField = ManagedMemberInspection["fields"][number];
export type ManagedMethod = ManagedMemberInspection["methods"][number];
export type ManagedMemberRef = ManagedMemberInspection["member_refs"][number];
export type ManagedCallEdge = ManagedMemberInspection["call_edges"][number];
export type ManagedFieldAccess =
  ManagedMemberInspection["field_accesses"][number];
export type ManagedSignature = ManagedMethod["signature"];
export type ManagedMethodBody = ManagedMethod["body"];
export type ManagedInstructionAnchor = ManagedMethodBody["anchors"][number];
export type ManagedExceptionRegion =
  ManagedMethodBody["exception_regions"][number];

export interface TypeRange {
  readonly token: string;
  readonly fullName: string | null;
  readonly fieldStart: number;
  readonly fieldEnd: number;
  readonly methodStart: number;
  readonly methodEnd: number;
}

export interface MethodCore {
  readonly token: string;
  readonly name: string;
  readonly declaringType: string | null;
}

export interface FieldCore {
  readonly token: string;
  readonly name: string;
}

export interface MemberRefCore {
  readonly token: string;
  readonly name: string;
}

export interface ParsedInstruction {
  readonly offset: number;
  readonly opcode: string;
  readonly operandKind: ManagedInstructionAnchor["operand_kind"];
  readonly operand: string | null;
}

const rowRange = (
  table: MetadataTableLayout | undefined,
  start: number,
  nextStart: number,
): {
  readonly first: number | null;
  readonly last: number | null;
  readonly count: number;
} => {
  const total = table?.rowCount ?? 0;
  if (total === 0 || start === 0) return { first: null, last: null, count: 0 };
  const end = Math.min(nextStart === 0 ? total + 1 : nextStart, total + 1);
  if (start >= end) return { first: null, last: null, count: 0 };
  return { first: start, last: end - 1, count: end - start };
};

const fullName = (namespace: string, name: string): string =>
  namespace.length === 0 ? name : `${namespace}.${name}`;

const readTypeRange = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
  issues: ManagedParseIssue[],
): TypeRange => {
  const methods = layout.table(6);
  const fields = layout.table(4);
  const cursor = metadataRowCursor(bytes, layout, 2, row);
  cursor.readUInt32();
  const nameIndex = cursor.readIndex(layout.stringIndexSize);
  const namespaceIndex = cursor.readIndex(layout.stringIndexSize);
  const declaredName =
    readManagedValue(
      () =>
        fullName(
          readMetadataString(
            bytes,
            layout,
            namespaceIndex,
            layout.strings.size,
          ),
          readMetadataString(bytes, layout, nameIndex, layout.strings.size),
        ),
      issues,
    ) ?? null;
  cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
  const fieldStart = cursor.readIndex(layout.tableIndexSize(4));
  const methodStart = cursor.readIndex(layout.tableIndexSize(6));
  let nextField = (fields?.rowCount ?? 0) + 1;
  let nextMethod = (methods?.rowCount ?? 0) + 1;
  const typeTable = layout.table(2);
  if (typeTable !== undefined && row < typeTable.rowCount) {
    const next = metadataRowCursor(bytes, layout, 2, row + 1);
    next.readUInt32();
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.stringIndexSize);
    next.readIndex(layout.codedIndexSize("TypeDefOrRef"));
    nextField = next.readIndex(layout.tableIndexSize(4));
    nextMethod = next.readIndex(layout.tableIndexSize(6));
  }
  return {
    token: metadataToken(2, row),
    fullName: declaredName,
    fieldStart,
    fieldEnd: nextField,
    methodStart,
    methodEnd: nextMethod,
  };
};

export const typeRanges = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): readonly TypeRange[] => {
  const typeTable = layout.table(2);
  const ranges: TypeRange[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1)
    ranges.push(readTypeRange(bytes, layout, row, issues));
  return ranges;
};

export const declaringType = (
  ranges: readonly TypeRange[],
  table: "field" | "method",
  row: number,
): { readonly token: string; readonly fullName: string | null } | null => {
  for (const range of ranges) {
    const start = table === "field" ? range.fieldStart : range.methodStart;
    const end = table === "field" ? range.fieldEnd : range.methodEnd;
    if (row >= start && row < end)
      return { token: range.token, fullName: range.fullName };
  }
  return null;
};

/** Resolve member ownership without rescanning ordered type ranges per row. */
export const createDeclaringTypeLookup = (
  ranges: readonly TypeRange[],
  table: "field" | "method",
): ((row: number) => ReturnType<typeof declaringType>) => {
  const entries = ranges.map((range) => ({
    range,
    start: table === "field" ? range.fieldStart : range.methodStart,
    end: table === "field" ? range.fieldEnd : range.methodEnd,
  }));
  const ordered = entries.every((entry, index) => {
    const previous = entries[index - 1];
    return (
      entry.start <= entry.end &&
      (previous === undefined || previous.end <= entry.start)
    );
  });
  // Malformed metadata can overlap or reverse ranges. Retain the original
  // first-match interpretation rather than guessing a different owner.
  if (!ordered) return (row) => declaringType(ranges, table, row);
  return (row) => {
    let first = 0;
    let end = entries.length;
    while (first < end) {
      const middle = first + Math.floor((end - first) / 2);
      const entry = entries[middle];
      if (entry === undefined) return null;
      if (row >= entry.start && row < entry.end)
        return { token: entry.range.token, fullName: entry.range.fullName };
      if (row < entry.start) end = middle;
      else first = middle + 1;
    }
    return null;
  };
};

export const parseTypes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
): {
  readonly types: readonly ManagedType[];
  readonly issues: readonly ManagedParseIssue[];
} => {
  const typeTable = layout.table(2);
  const fields = layout.table(4);
  const methods = layout.table(6);
  const items: ManagedType[] = [];
  const issues: ManagedParseIssue[] = [];
  for (let row = 1; row <= (typeTable?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 2, row);
      const flags = cursor.readUInt32();
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
      const extendsOffset = cursor.offset;
      const extendsRaw = cursor.readIndex(
        layout.codedIndexSize("TypeDefOrRef"),
      );
      const fieldStart = cursor.readIndex(layout.tableIndexSize(4));
      const methodStart = cursor.readIndex(layout.tableIndexSize(6));
      const nextRange = ranges[row] ?? null;
      const fieldRange = rowRange(
        fields,
        fieldStart,
        nextRange?.fieldStart ?? 0,
      );
      const methodRange = rowRange(
        methods,
        methodStart,
        nextRange?.methodStart ?? 0,
      );
      const extendsReason = metadataCodedTokenInvalidReason(
        extendsRaw,
        2,
        [2, 1, 27],
        layout.rowCounts,
      );
      if (extendsReason !== null)
        issues.push({
          code: "invalid-row",
          scope: `metadata.TypeDef:${metadataToken(2, row)}`,
          offset: extendsOffset,
          detail: `TypeDef Extends coded index 0x${extendsRaw.toString(16)} is invalid: ${extendsReason}`,
        });
      items.push({
        token: metadataToken(2, row),
        row_offset: cursor.start,
        namespace,
        name,
        full_name: fullName(namespace, name),
        flags,
        extends_token: metadataCodedToken(
          extendsRaw,
          2,
          [2, 1, 27],
          layout.rowCounts,
        ),
        field_list: {
          first_row: fieldRange.first,
          last_row: fieldRange.last,
          count: fieldRange.count,
        },
        method_list: {
          first_row: methodRange.first,
          last_row: methodRange.last,
          count: methodRange.count,
        },
      });
    }, issues);
  }
  return { types: items, issues };
};

const IMPLEMENTATION_TABLES = [38, 35, 39] as const;

interface RawExportedType {
  readonly row: number;
  readonly rowOffset: number;
  readonly flags: number;
  readonly typeDefId: number;
  readonly namespace: string;
  readonly name: string;
  readonly implementationRaw: number;
  readonly implementationOffset: number;
}

const readExportedTypeRow = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): RawExportedType => {
  const heapString = (index: number): string =>
    readMetadataString(bytes, layout, index, layout.strings.size);
  const cursor = metadataRowCursor(bytes, layout, 39, row);
  const flags = cursor.readUInt32();
  const typeDefId = cursor.readUInt32();
  const nameIndex = cursor.readIndex(layout.stringIndexSize);
  const namespaceIndex = cursor.readIndex(layout.stringIndexSize);
  const implementationOffset = cursor.offset;
  const implementationRaw = cursor.readIndex(
    layout.codedIndexSize("Implementation"),
  );
  return {
    row,
    rowOffset: cursor.start,
    flags,
    typeDefId,
    namespace: heapString(namespaceIndex),
    name: heapString(nameIndex),
    implementationRaw,
    implementationOffset,
  };
};

const exportedTypeParent = (
  rows: ReadonlyMap<number, RawExportedType>,
  raw: RawExportedType,
): RawExportedType | undefined =>
  (raw.implementationRaw & 3) === 2
    ? rows.get(Math.floor(raw.implementationRaw / 4))
    : undefined;

/** Each walked level repeats inside every descendant name, so the walk is bounded. */
const MAX_EXPORTED_TYPE_NESTING = 64;

/**
 * Nested exported types link to their parent ExportedType row through
 * Implementation. Join names outermost-first with the metadata `/` separator
 * so identical short names stay distinguishable. The bounded walk reports a
 * cycle, or a chain deeper than MAX_EXPORTED_TYPE_NESTING, instead of
 * following it, and the joined name's JSON bytes are reserved before it is
 * built because each level repeats inside every descendant.
 */
const exportedTypeFullName = (
  layout: ManagedMetadataLayout,
  rows: ReadonlyMap<number, RawExportedType>,
  raw: RawExportedType,
  issues: ManagedParseIssue[],
): string => {
  const parents: RawExportedType[] = [];
  const path = new Set<number>([raw.row]);
  let parent = exportedTypeParent(rows, raw);
  while (parent !== undefined) {
    if (path.has(parent.row)) {
      issues.push({
        code: "invalid-row",
        scope: `metadata.ExportedType:${metadataToken(39, parent.row)}`,
        offset: metadataRowOffset(layout, 39, parent.row),
        detail:
          "ExportedType Implementation chain revisits a row before reaching a top-level type",
      });
      break;
    }
    if (parents.length === MAX_EXPORTED_TYPE_NESTING) {
      issues.push({
        code: "invalid-row",
        scope: `metadata.ExportedType:${metadataToken(39, raw.row)}`,
        offset: raw.rowOffset,
        detail: `ExportedType Implementation chain exceeds ${String(MAX_EXPORTED_TYPE_NESTING)} nesting levels; full_name joins only its innermost levels`,
      });
      break;
    }
    path.add(parent.row);
    parents.push(parent);
    parent = exportedTypeParent(rows, parent);
  }
  const outermost = parents[parents.length - 1] ?? raw;
  const segments = [fullName(outermost.namespace, outermost.name)];
  for (const nested of parents.slice(0, -1).reverse())
    segments.push(nested.name);
  if (parents.length > 0) segments.push(raw.name);
  let bytes = 0;
  for (const [index, segment] of segments.entries())
    bytes += managedJsonStringBytes(segment) - (index === 0 ? 0 : 1);
  managedDecodeBudget(layout).reserve(bytes, raw.rowOffset);
  return segments.join("/");
};

const readExportedTypeImplementation = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  raw: RawExportedType,
  names: ReadonlyMap<number, string>,
  issues: ManagedParseIssue[],
): ManagedExportedType["implementation"] => {
  const unresolved: ManagedExportedType["implementation"] = {
    kind: "unresolved",
    token: null,
    name: null,
    version: null,
  };
  if (raw.implementationRaw === 0)
    return { ...unresolved, kind: "current-module" };
  const reason = metadataCodedTokenInvalidReason(
    raw.implementationRaw,
    2,
    IMPLEMENTATION_TABLES,
    layout.rowCounts,
  );
  if (reason !== null) {
    issues.push({
      code: "invalid-row",
      scope: `metadata.ExportedType:${metadataToken(39, raw.row)}`,
      offset: raw.implementationOffset,
      detail: `ExportedType implementation coded index 0x${raw.implementationRaw.toString(16)} is invalid: ${reason}`,
    });
    return unresolved;
  }
  const token = metadataCodedToken(
    raw.implementationRaw,
    2,
    IMPLEMENTATION_TABLES,
    layout.rowCounts,
  );
  const tag = raw.implementationRaw & 3;
  const row = Math.floor(raw.implementationRaw / 4);
  if (tag === 1) {
    const reference = readAssemblyReference(
      bytes,
      layout,
      row,
      layout.strings.size,
    );
    return {
      kind: "assembly-ref",
      token,
      name: reference.name,
      version: reference.version,
    };
  }
  if (tag === 0) {
    const cursor = metadataRowCursor(bytes, layout, 38, row);
    cursor.readUInt32();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      layout.strings.size,
    );
    return { kind: "file", token, name, version: null };
  }
  return {
    kind: "exported-type",
    token,
    name: names.get(row) ?? null,
    version: null,
  };
};

/**
 * Inventory ExportedType rows: type forwarders and exported nested types are
 * absent from the TypeDef view, so facade assemblies need this table to expose
 * forwarded types and their implementation targets.
 */
export const parseExportedTypes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): {
  readonly exportedTypes: readonly ManagedExportedType[];
  readonly issues: readonly ManagedParseIssue[];
} => {
  const issues: ManagedParseIssue[] = [];
  const rows = new Map<number, RawExportedType>();
  const total = layout.table(39)?.rowCount ?? 0;
  for (let row = 1; row <= total; row += 1)
    readManagedValue(() => {
      rows.set(row, readExportedTypeRow(bytes, layout, row));
    }, issues);
  const names = new Map<number, string>();
  for (const raw of rows.values())
    names.set(raw.row, exportedTypeFullName(layout, rows, raw, issues));
  const items: ManagedExportedType[] = [];
  for (const raw of rows.values()) {
    const implementation = readManagedValue(
      () => readExportedTypeImplementation(bytes, layout, raw, names, issues),
      issues,
    ) ?? {
      kind: "unresolved",
      token: null,
      name: null,
      version: null,
    };
    items.push({
      token: metadataToken(39, raw.row),
      row_offset: raw.rowOffset,
      flags: raw.flags,
      forwarder: (raw.flags & 0x0020_0000) !== 0,
      type_def_id: raw.typeDefId,
      namespace: raw.namespace,
      name: raw.name,
      full_name: names.get(raw.row) ?? fullName(raw.namespace, raw.name),
      implementation,
    });
  }
  return { exportedTypes: items, issues };
};

const readCompressed = (
  bytes: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } => {
  const first = bytes[offset];
  if (first === undefined)
    throw managedFailure(
      "invalid-blob",
      "signature",
      "truncated compressed integer",
      offset,
    );
  if ((first & 0x80) === 0) return { value: first, next: offset + 1 };
  const second = bytes[offset + 1];
  if ((first & 0xc0) === 0x80 && second !== undefined)
    return { value: ((first & 0x3f) << 8) | second, next: offset + 2 };
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    (first & 0xe0) === 0xc0 &&
    b1 !== undefined &&
    b2 !== undefined &&
    b3 !== undefined
  )
    return {
      value:
        (first & 0x1f) * 0x01_00_00_00 + b1 * 0x01_00_00 + b2 * 0x0100 + b3,
      next: offset + 4,
    };
  throw managedFailure(
    "invalid-blob",
    "signature",
    "reserved compressed integer",
    offset,
  );
};

const ELEMENT_TYPES = new Map<number, string>([
  [0x01, "void"],
  [0x02, "bool"],
  [0x03, "char"],
  [0x04, "i1"],
  [0x05, "u1"],
  [0x06, "i2"],
  [0x07, "u2"],
  [0x08, "i4"],
  [0x09, "u4"],
  [0x0a, "i8"],
  [0x0b, "u8"],
  [0x0c, "r4"],
  [0x0d, "r8"],
  [0x0e, "string"],
  [0x18, "native-int"],
  [0x19, "native-uint"],
  [0x1c, "object"],
]);

const readTypeSignature = (
  blob: Buffer,
  offset: number,
): { readonly value: string; readonly next: number } => {
  const suffixes: string[] = [];
  let cursor = offset;
  let kind = blob[cursor];
  while (kind === 0x0f || kind === 0x10 || kind === 0x1d) {
    suffixes.push(kind === 0x0f ? "*" : kind === 0x10 ? "&" : "[]");
    cursor += 1;
    kind = blob[cursor];
  }
  if (kind === undefined)
    throw managedFailure(
      "invalid-blob",
      "signature",
      "truncated type signature",
      cursor,
    );
  const named = ELEMENT_TYPES.get(kind);
  let value: string;
  let next: number;
  if (named !== undefined) {
    value = named;
    next = cursor + 1;
  } else if (kind === 0x11 || kind === 0x12) {
    const token = readCompressed(blob, cursor + 1);
    value = `${kind === 0x11 ? "valuetype" : "class"}:${String(token.value)}`;
    next = token.next;
  } else if (kind === 0x1e || kind === 0x13) {
    const variable = readCompressed(blob, cursor + 1);
    value = `${kind === 0x1e ? "mvar" : "var"}:${String(variable.value)}`;
    next = variable.next;
  } else {
    throw managedFailure(
      "unsupported-signature",
      "signature",
      `unsupported element type 0x${kind.toString(16)}`,
      cursor,
    );
  }
  return { value: value + suffixes.reverse().join(""), next };
};

const callingConvention = (value: number): string => {
  const base = value & 0x0f;
  const flags = [
    (value & 0x20) === 0 ? null : "has-this",
    (value & 0x40) === 0 ? null : "explicit-this",
    (value & 0x10) === 0 ? null : "generic",
  ].filter((flag) => flag !== null);
  const name =
    base === 0
      ? "default"
      : base === 5
        ? "vararg"
        : base === 6
          ? "field"
          : `unknown:${String(base)}`;
  return flags.length === 0 ? name : `${name} ${flags.join(" ")}`;
};

export const signature = (
  blob: Buffer,
  rawSha256?: string,
): ManagedSignature => {
  const raw = {
    raw_length: blob.length,
    raw_sha256: rawSha256 ?? sha256Bytes(blob),
  };
  try {
    if (blob.length === 0)
      throw managedFailure("invalid-blob", "signature", "empty signature", 0);
    const first = blob[0] ?? 0;
    if ((first & 0x0f) === 6) {
      const fieldType = readTypeSignature(blob, 1);
      return {
        ...raw,
        kind: "field",
        parse_status: fieldType.next === blob.length ? "decoded" : "partial",
        calling_convention: callingConvention(first),
        generic_parameter_count: null,
        parameter_count: null,
        return_type: null,
        parameter_types: [],
        field_type: fieldType.value,
        issue:
          fieldType.next === blob.length ? null : "Trailing signature data",
      };
    }
    let offset = 1;
    let genericParameterCount: number | null = null;
    if ((first & 0x10) !== 0) {
      const generic = readCompressed(blob, offset);
      genericParameterCount = generic.value;
      offset = generic.next;
    }
    const parameterCount = readCompressed(blob, offset);
    offset = parameterCount.next;
    const returnType = readTypeSignature(blob, offset);
    offset = returnType.next;
    const parameters: string[] = [];
    for (let index = 0; index < parameterCount.value; index += 1) {
      const parameter = readTypeSignature(blob, offset);
      parameters.push(parameter.value);
      offset = parameter.next;
    }
    return {
      ...raw,
      kind: "method",
      parse_status: offset === blob.length ? "decoded" : "partial",
      calling_convention: callingConvention(first),
      generic_parameter_count: genericParameterCount,
      parameter_count: parameterCount.value,
      return_type: returnType.value,
      parameter_types: parameters,
      field_type: null,
      issue: offset === blob.length ? null : "Trailing signature data",
    };
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    if (
      cause.issue.code !== "invalid-blob" &&
      cause.issue.code !== "unsupported-signature"
    )
      throw cause;
    return {
      ...raw,
      kind: "unknown",
      parse_status:
        cause.issue.code === "unsupported-signature"
          ? "unsupported"
          : "malformed",
      calling_convention: null,
      generic_parameter_count: null,
      parameter_count: null,
      return_type: null,
      parameter_types: [],
      field_type: null,
      issue: cause.issue.detail,
    };
  }
};
