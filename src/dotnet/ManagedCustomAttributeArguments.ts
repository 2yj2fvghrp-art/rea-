import type { ManagedArtifactInspection } from "../domain/managed/managedArtifact.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../domain/jsonValue.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import {
  methodSignatureTypes,
  readCompressed,
  fieldSignatureType,
  type ManagedSignatureType,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataCodedToken,
  metadataRowCursor,
  readMetadataBlob,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { memberDeclaringTypeRowLookup } from "./ManagedMemberOwnership.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./ManagedReaderFailure.js";

type Arguments = NonNullable<
  ManagedArtifactInspection["attributes"][number]["arguments"]
>;
type Argument = Arguments["fixed"][number];
const enumTypes = new WeakMap<
  ManagedMetadataLayout,
  Map<number, AttributeType>
>();

interface AttributeType {
  readonly element: number;
  readonly name: string;
  readonly child?: AttributeType;
  readonly enumWidth?: number;
}

const primitiveNames = new Map<number, string>([
  [2, "bool"],
  [3, "char"],
  [4, "int8"],
  [5, "uint8"],
  [6, "int16"],
  [7, "uint16"],
  [8, "int32"],
  [9, "uint32"],
  [10, "int64"],
  [11, "uint64"],
  [12, "float32"],
  [13, "float64"],
  [14, "string"],
  [28, "object"],
  [0x50, "System.Type"],
]);
const widths = new Map<number, number>([
  [2, 1],
  [3, 2],
  [4, 1],
  [5, 1],
  [6, 2],
  [7, 2],
  [8, 4],
  [9, 4],
  [10, 8],
  [11, 8],
  [12, 4],
  [13, 8],
]);

const enumUnderlyingType = (
  type: AttributeType,
): { value: string; kind: "derived" } | null => {
  let element = type;
  while (element.child !== undefined) element = element.child;
  return element.enumWidth === undefined
    ? null
    : {
        value: primitiveNames.get(element.enumWidth) ?? "unknown",
        kind: "derived",
      };
};

/** One inspection owns metadata identity and never opens referenced assemblies. */
class AttributeDecoder {
  offset = 0;
  constructor(
    readonly bytes: Buffer,
    readonly layout: ManagedMetadataLayout,
    readonly blob: Buffer,
  ) {}
  fail(detail: string): never {
    throw managedFailure(
      "invalid-blob",
      "custom-attribute.arguments",
      detail,
      this.offset,
    );
  }
  unsupported(detail: string): never {
    throw managedFailure(
      "unsupported-signature",
      "custom-attribute.arguments",
      detail,
      this.offset,
    );
  }
  require(size: number): void {
    if (size > this.blob.length - this.offset)
      this.fail("truncated custom attribute argument");
  }
  byte(): number {
    this.require(1);
    return this.blob[this.offset++] ?? 0;
  }
  uint16(): number {
    this.require(2);
    const value = this.blob.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }
  string(): string | null {
    this.require(1);
    if (this.blob[this.offset] === 0xff) {
      this.offset++;
      return null;
    }
    const length = readCompressed(this.blob, this.offset);
    this.offset = length.next;
    this.require(length.value);
    managedDecodeBudget(this.layout).reserveString(length.value, this.offset);
    const start = this.offset;
    this.offset += length.value;
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        this.blob.subarray(start, this.offset),
      );
    } catch {
      return this.fail("invalid UTF-8 custom attribute string");
    }
  }
  typeIdentity(operand: number): {
    readonly table: number;
    readonly row: number;
    readonly name: string;
  } {
    const token = metadataCodedToken(
      operand,
      2,
      [2, 1, 27],
      this.layout.rowCounts,
    );
    if (token === null)
      return this.unsupported("unresolved custom attribute parameter type");
    const table = Number.parseInt(token.slice(2, 4), 16);
    const row = Number.parseInt(token.slice(4), 16);
    if (table !== 1 && table !== 2)
      return this.unsupported("custom attribute TypeSpec is not supported");
    const cursor = metadataRowCursor(this.bytes, this.layout, table, row);
    if (table === 1)
      cursor.readIndex(this.layout.codedIndexSize("ResolutionScope"));
    else cursor.readUInt32();
    const name = readMetadataString(
      this.bytes,
      this.layout,
      cursor.readIndex(this.layout.stringIndexSize),
      this.layout.strings.size,
    );
    const namespace = readMetadataString(
      this.bytes,
      this.layout,
      cursor.readIndex(this.layout.stringIndexSize),
      this.layout.strings.size,
    );
    return {
      table,
      row,
      name: namespace.length === 0 ? name : `${namespace}.${name}`,
    };
  }
  localEnum(row: number, name: string): AttributeType {
    let cached = enumTypes.get(this.layout);
    const existing = cached?.get(row);
    if (existing !== undefined) return existing;
    const typeRow = metadataRowCursor(this.bytes, this.layout, 2, row);
    typeRow.readUInt32();
    typeRow.readIndex(this.layout.stringIndexSize);
    typeRow.readIndex(this.layout.stringIndexSize);
    const base = typeRow.readIndex(this.layout.codedIndexSize("TypeDefOrRef"));
    if (base === 0 || this.typeIdentity(base).name !== "System.Enum")
      return this.unsupported(`value type ${name} is not a proven local enum`);
    const owner = memberDeclaringTypeRowLookup(this.bytes, this.layout, 4);
    let width: number | undefined;
    for (
      let field = 1;
      field <= (this.layout.table(4)?.rowCount ?? 0);
      field++
    ) {
      if (owner(field) !== row) continue;
      const cursor = metadataRowCursor(this.bytes, this.layout, 4, field);
      const flags = cursor.readUInt16();
      const fieldName = readMetadataString(
        this.bytes,
        this.layout,
        cursor.readIndex(this.layout.stringIndexSize),
        this.layout.strings.size,
      );
      const blob = readMetadataBlob(
        this.bytes,
        this.layout,
        cursor.readIndex(this.layout.blobIndexSize),
        this.layout.blob.size,
      );
      if (fieldName !== "value__" || (flags & 0x10) !== 0) continue;
      const parsed = fieldSignatureType(blob, this.layout);
      if (
        parsed.next !== blob.length ||
        ![4, 5, 6, 7, 8, 9, 10, 11].includes(parsed.shape.element)
      )
        return this.unsupported(
          `enum ${name} has an unsupported value__ field`,
        );
      if (width !== undefined)
        return this.unsupported(`enum ${name} has ambiguous value__ fields`);
      width = parsed.shape.element;
    }
    const type = {
      element: 0x55,
      name,
      ...(width === undefined ? {} : { enumWidth: width }),
    };
    managedDecodeBudget(this.layout).reserve(256, this.offset);
    if (cached === undefined) {
      cached = new Map();
      enumTypes.set(this.layout, cached);
    }
    cached.set(row, type);
    return type;
  }
  type(shape: ManagedSignatureType, depth = 0): AttributeType {
    if (depth >= MAX_JSON_DEPTH / 2)
      return this.unsupported(
        "attribute parameter exceeds JSON nesting capacity",
      );
    const name = primitiveNames.get(shape.element);
    if (name !== undefined) return { element: shape.element, name };
    if (shape.element === 0x1d && shape.children?.[0] !== undefined) {
      const child = this.type(shape.children[0], depth + 1);
      return { element: 0x1d, name: `${child.name}[]`, child };
    }
    if (
      (shape.element === 0x11 || shape.element === 0x12) &&
      shape.operand !== undefined
    ) {
      const identity = this.typeIdentity(shape.operand);
      if (shape.element === 0x12 && identity.name === "System.Type")
        return { element: 0x50, name: identity.name };
      if (shape.element !== 0x11)
        return this.unsupported(
          `unsupported attribute class parameter ${identity.name}`,
        );
      return identity.table === 2
        ? this.localEnum(identity.row, identity.name)
        : { element: 0x55, name: identity.name };
    }
    return this.unsupported(
      `unsupported attribute parameter element 0x${shape.element.toString(16)}`,
    );
  }
  taggedType(depth = 0): AttributeType {
    if (depth >= MAX_JSON_DEPTH / 2)
      return this.unsupported("attribute type exceeds JSON nesting capacity");
    const element = this.byte();
    if (element === 0x1d) {
      const child = this.taggedType(depth + 1);
      return { element, name: `${child.name}[]`, child };
    }
    if (element === 0x55) {
      const name = this.string();
      if (name === null) return this.fail("enum type name is null");
      // Serialized names can be assembly-qualified. Keep the name verbatim;
      // only an exact local identity with no external qualification resolves.
      for (let row = 1; row <= (this.layout.table(2)?.rowCount ?? 0); row++) {
        if (this.typeIdentity(row << 2).name === name)
          return this.localEnum(row, name);
      }
      return { element, name };
    }
    const name =
      element === 0x1c
        ? undefined
        : primitiveNames.get(element === 0x51 ? 28 : element);
    if (name === undefined)
      return this.fail(`invalid FieldOrPropType 0x${element.toString(16)}`);
    return { element: element === 0x51 ? 28 : element, name };
  }
  value(type: AttributeType, depth = 0): JsonValue {
    if (depth >= MAX_JSON_DEPTH / 2)
      return this.unsupported("attribute value exceeds JSON nesting capacity");
    if (type.element === 14 || type.element === 0x50) return this.string();
    if (type.element === 28) {
      const boxed = this.taggedType();
      return {
        type: boxed.name,
        value: this.value(boxed, depth + 1),
        enum_underlying_type: enumUnderlyingType(boxed),
      };
    }
    if (type.element === 0x1d) {
      this.require(4);
      const count = this.blob.readUInt32LE(this.offset);
      this.offset += 4;
      if (count === 0xffffffff) return null;
      if (count > this.blob.length - this.offset)
        return this.fail("array count exceeds remaining attribute bytes");
      managedDecodeBudget(this.layout).reserve(count * 128 + 2, this.offset);
      const values: JsonValue[] = [];
      if (type.child === undefined)
        return this.unsupported("unresolved array element type");
      for (let index = 0; index < count; index++)
        values.push(this.value(type.child, depth + 1));
      return values;
    }
    if (type.element === 0x55) {
      if (type.enumWidth === undefined)
        return this.unsupported(
          `enum underlying type for ${type.name} was not resolved in the inspected module; referenced assemblies were not inspected`,
        );
      return this.value(
        {
          element: type.enumWidth,
          name: primitiveNames.get(type.enumWidth) ?? "unknown",
        },
        depth,
      );
    }
    const size = widths.get(type.element);
    if (size === undefined)
      return this.unsupported(`unsupported attribute argument ${type.name}`);
    this.require(size);
    const at = this.offset;
    this.offset += size;
    switch (type.element) {
      case 2: {
        const value = this.blob[at];
        if (value !== 0 && value !== 1)
          return this.fail("invalid Boolean attribute value");
        return value === 1;
      }
      case 3:
        return String.fromCharCode(this.blob.readUInt16LE(at));
      case 4:
        return this.blob.readInt8(at);
      case 5:
        return this.blob.readUInt8(at);
      case 6:
        return this.blob.readInt16LE(at);
      case 7:
        return this.blob.readUInt16LE(at);
      case 8:
        return this.blob.readInt32LE(at);
      case 9:
        return this.blob.readUInt32LE(at);
      case 10:
        return this.blob.readBigInt64LE(at).toString();
      case 11:
        return this.blob.readBigUInt64LE(at).toString();
      default: {
        const value =
          type.element === 12
            ? this.blob.readFloatLE(at)
            : this.blob.readDoubleLE(at);
        return Number.isFinite(value) ? value : String(value);
      }
    }
  }
  argument(type: AttributeType): Argument {
    managedDecodeBudget(this.layout).reserve(256, this.offset);
    const blob_offset = this.offset;
    const value = this.value(type);
    return {
      type: type.name,
      value,
      blob_offset,
      status: "decoded",
      reason: null,
      enum_underlying_type: enumUnderlyingType(type),
    };
  }
}

/** Decode values only from the constructor signature owner's structured facts. */
export const decodeCustomAttributeArguments = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  blob: Buffer,
  constructor: string | null,
): Arguments => {
  const fixed: Argument[] = [];
  const named: Arguments["named"] = [];
  const decoder = new AttributeDecoder(bytes, layout, blob);
  let parameters: readonly ManagedSignatureType[] = [];
  try {
    if (constructor === null)
      return decoder.unsupported("custom attribute constructor is unresolved");
    const table = Number.parseInt(constructor.slice(2, 4), 16);
    const row = Number.parseInt(constructor.slice(4), 16);
    const cursor = metadataRowCursor(bytes, layout, table, row);
    if (table === 6) {
      cursor.readUInt32();
      cursor.readUInt16();
      cursor.readUInt16();
    } else if (table === 10)
      cursor.readIndex(layout.codedIndexSize("MemberRefParent"));
    else
      decoder.unsupported(
        "custom attribute constructor must be MethodDef or MemberRef",
      );
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      layout.strings.size,
    );
    if (name !== ".ctor")
      decoder.unsupported("custom attribute member is not a constructor");
    const signatureBlob = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      layout.blob.size,
    );
    managedDecodeBudget(layout).admitTransient(
      signatureBlob.length * 256,
      layout.blob.offset,
    );
    const parsed = methodSignatureTypes(signatureBlob, layout);
    if (
      parsed.next !== signatureBlob.length ||
      parsed.result.shape.element !== 1 ||
      parsed.header.first !== 0x20
    )
      decoder.unsupported(
        "attribute constructor must have a complete instance default void signature",
      );
    parameters = parsed.parameters.map(({ shape }) => shape);
    if (decoder.uint16() !== 1) decoder.fail("invalid custom attribute prolog");
    for (const parameter of parameters)
      fixed.push(decoder.argument(decoder.type(parameter)));
    const count = decoder.uint16();
    if (count > Math.floor((blob.length - decoder.offset) / 4))
      decoder.fail("named argument count exceeds remaining attribute bytes");
    for (let index = 0; index < count; index++) {
      const tag = decoder.byte();
      if (tag !== 0x53 && tag !== 0x54)
        decoder.fail("named argument must be FIELD or PROPERTY");
      const type = decoder.taggedType();
      const name = decoder.string();
      if (name === null) return decoder.fail("named argument name is null");
      named.push({
        ...decoder.argument(type),
        kind: tag === 0x53 ? "field" : "property",
        name,
      });
    }
    if (decoder.offset !== blob.length)
      decoder.fail("trailing custom attribute data");
    return { status: "decoded", reason: null, fixed, named };
  } catch (cause: unknown) {
    if (
      !(cause instanceof ManagedReaderFailure) ||
      cause.issue.code === "resource-limit"
    )
      throw cause;
    const reason = cause.issue.detail;
    if (cause.issue.code === "unsupported-signature") {
      const unknownStart = fixed.length;
      for (let index = unknownStart; index < parameters.length; index++) {
        managedDecodeBudget(layout).reserve(256, decoder.offset);
        fixed.push({
          type: "unknown",
          value: null,
          blob_offset: index === unknownStart ? decoder.offset : null,
          status: "unknown",
          reason,
          enum_underlying_type: null,
        });
      }
    }
    return {
      status:
        cause.issue.code === "unsupported-signature"
          ? fixed.some((x) => x.status === "decoded") || named.length > 0
            ? "partial"
            : "unsupported"
          : "malformed",
      reason,
      fixed,
      named,
    };
  } finally {
    managedDecodeBudget(layout).releaseTransient();
  }
};
