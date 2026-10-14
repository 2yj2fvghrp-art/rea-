import { createHash } from "node:crypto";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { parseCodeViewData } from "../../domain/binaryTarget.js";
import type {
  InspectPeDebugDirectoryInput,
  PeDebugDirectory,
  PeDebugPayload,
} from "../../domain/native/peDebugDirectory.js";
import { peDebugTypeName } from "../../domain/native/peDebugDirectory.js";
import {
  peFailure,
  readPeImageLayout,
  requirePeRange,
} from "./PeResourceLayout.js";

const ENTRY_SIZE = 28;
const DEBUG_DIRECTORY_INDEX = 6;
const MAX_DECODED_OUTPUT_BYTES = 256 * 1024;

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const utf16z = (bytes: Buffer): number => {
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0) return offset;
  }
  return -1;
};

const limit = (message: string): never => {
  throw new ArtifactReaderFailure("limit", message);
};

const decodeRepro = (
  data: Buffer,
  take: (bytes: number) => boolean,
): PeDebugPayload | undefined => {
  if (data.length < 4) return undefined;
  const hashLength = data.readUInt32LE(0);
  if (hashLength === 0 || hashLength > data.length - 4) return undefined;
  if (!take(hashLength * 2)) return { kind: "opaque" };
  return {
    kind: "repro",
    hash_hex: data.subarray(4, 4 + hashLength).toString("hex"),
  };
};

const decodeMisc = (
  data: Buffer,
  take: (bytes: number) => boolean,
): PeDebugPayload | undefined => {
  if (data.length < 12) return undefined;
  const declared = data.readUInt32LE(4);
  if (declared > data.length) return { kind: "opaque" };
  const unicode = data[8] !== 0;
  const content = data.subarray(12, declared === 0 ? data.length : declared);
  const end = unicode ? utf16z(content) : content.indexOf(0);
  const pathBytes =
    end === -1 ? content : content.subarray(0, Math.max(0, end));
  if (!take(pathBytes.length)) return { kind: "opaque" };
  const path =
    pathBytes.length === 0
      ? null
      : unicode
        ? pathBytes.toString("utf16le")
        : pathBytes.toString("utf8");
  return {
    kind: "misc",
    data_type: data.readUInt32LE(0),
    unicode,
    path: path === "" ? null : path,
  };
};

const decodePayload = (
  type: number,
  data: Buffer,
  take: (bytes: number) => boolean,
): PeDebugPayload => {
  if (type === 2) {
    const parsed = parseCodeViewData(data, data.length);
    if (parsed?.guid !== undefined && parsed.guid !== null)
      return {
        kind: "codeview_rsds",
        pdb_path: parsed.pdbPath,
        pdb_file_name: parsed.pdbFileName,
        guid: parsed.guid,
        age: parsed.age,
      };
    if (parsed !== undefined)
      return {
        kind: "codeview_nb10",
        pdb_path: parsed.pdbPath,
        pdb_file_name: parsed.pdbFileName,
        age: parsed.age,
      };
    return {
      kind: "codeview_unparsed",
      magic: data.length >= 4 ? data.subarray(0, 4).toString("binary") : "",
    };
  }
  if (type === 16) {
    const repro = decodeRepro(data, take);
    if (repro !== undefined) return repro;
  }
  if (type === 20 && data.length === 4)
    return {
      kind: "ex_dllcharacteristics",
      characteristics: data.readUInt32LE(0),
    };
  if (type === 4) {
    const misc = decodeMisc(data, take);
    if (misc !== undefined) return misc;
  }
  return { kind: "opaque" };
};

const limitationsFor = (
  report: Omit<PeDebugDirectory, "limitations">,
  decodedOutputBounded = false,
): string[] => {
  const limitations = [
    "Static PE32/PE32+ IMAGE_DEBUG_DIRECTORY inventory; payloads are not loaded as symbols and no PDB is fetched.",
    "A missing debug directory is an empty inventory. Absence does not prove the image was built without debug information.",
    "CodeView PDB paths, GUIDs and ages are file content. They do not authenticate a matching PDB or prove symbols can be applied.",
  ];
  if (
    report.entries.some(
      (entry) => entry.payload.decoded.kind === "codeview_unparsed",
    )
  )
    limitations.push(
      "At least one CodeView payload was not RSDS or NB10 with a terminating PDB path, so its decoded path remains unparsed.",
    );
  if (decodedOutputBounded)
    limitations.push(
      `Decoded payload text is bounded to ${String(MAX_DECODED_OUTPUT_BYTES / 1024)} KiB; payloads that would exceed it stay opaque instead of unbounded output.`,
    );
  return limitations;
};

const readDebugEntries = (
  bytes: Buffer,
  map: (rva: number, size: number) => number,
  fileOffset: number,
  count: number,
) => {
  const entries: PeDebugDirectory["entries"] = [];
  const shaByRange = new Map<string, string>();
  const decodedByKey = new Map<string, PeDebugPayload>();
  let payloadBytes = 0;
  let decodedOutputBytes = 0;
  let decodedOutputBounded = false;
  const take = (needed: number): boolean => {
    if (needed > MAX_DECODED_OUTPUT_BYTES - decodedOutputBytes) {
      decodedOutputBounded = true;
      return false;
    }
    decodedOutputBytes += needed;
    return true;
  };
  for (let index = 0; index < count; index++) {
    const at = fileOffset + index * ENTRY_SIZE;
    const type = bytes.readUInt32LE(at + 12);
    const sizeOfData = bytes.readUInt32LE(at + 16);
    const addressOfRawData = bytes.readUInt32LE(at + 20);
    const pointerToRawData = bytes.readUInt32LE(at + 24);
    let payloadOffset = pointerToRawData;
    if (payloadOffset === 0 && sizeOfData > 0)
      payloadOffset = map(addressOfRawData, sizeOfData);
    else if (sizeOfData > 0) requirePeRange(bytes, payloadOffset, sizeOfData);
    const rangeKey = `${String(payloadOffset)}:${String(sizeOfData)}`;
    let sha256 = shaByRange.get(rangeKey);
    if (sha256 === undefined) {
      if (sizeOfData > bytes.length - payloadBytes)
        limit(
          "PE debug directory decoded payload budget exceeded; no partial inventory was returned.",
        );
      payloadBytes += sizeOfData;
      sha256 = hash(bytes.subarray(payloadOffset, payloadOffset + sizeOfData));
      shaByRange.set(rangeKey, sha256);
    }
    const decodeKey = `${String(type)}:${rangeKey}`;
    let decoded = decodedByKey.get(decodeKey);
    if (decoded === undefined) {
      decoded = decodePayload(
        type,
        bytes.subarray(payloadOffset, payloadOffset + sizeOfData),
        take,
      );
      decodedByKey.set(decodeKey, decoded);
    }
    entries.push({
      index,
      type,
      type_name: peDebugTypeName(type),
      characteristics: bytes.readUInt32LE(at),
      timestamp: bytes.readUInt32LE(at + 4),
      major_version: bytes.readUInt16LE(at + 8),
      minor_version: bytes.readUInt16LE(at + 10),
      directory_location: { offset: at, bytes: ENTRY_SIZE },
      address_of_raw_data: addressOfRawData,
      pointer_to_raw_data: pointerToRawData,
      payload: {
        location: { offset: payloadOffset, bytes: sizeOfData },
        sha256,
        decoded,
      },
    });
  }
  return { entries, decodedOutputBounded };
};

/** Decode the debug directory and each payload; never fetch symbols or execute the image. */
export const parsePeDebugDirectory = (
  bytes: Buffer,
  artifact: PeDebugDirectory["artifact"],
  input: InspectPeDebugDirectoryInput,
): PeDebugDirectory => {
  const image = readPeImageLayout(bytes);
  const directory = image.directories[DEBUG_DIRECTORY_INDEX];
  const rva = directory?.rva ?? 0;
  const size = directory?.size ?? 0;
  if ((rva === 0) !== (size === 0))
    peFailure("Inconsistent PE debug directory RVA/size.");
  if (size === 0) {
    const empty = {
      artifact,
      format: image.format,
      machine: image.machine,
      directory: null,
      entries: [],
      coverage: { status: "complete" as const, entries: 0 },
    };
    return { ...empty, limitations: limitationsFor(empty) };
  }
  if (size % ENTRY_SIZE !== 0)
    peFailure("PE debug directory size is not a multiple of 28.");
  const count = size / ENTRY_SIZE;
  if (count > input.max_entries)
    limit(
      "PE debug directory entry budget exceeded; no partial inventory was returned.",
    );
  const debugHeader =
    directory ?? peFailure("PE debug directory header is missing.");
  const fileOffset = image.map(rva, size);
  requirePeRange(bytes, fileOffset, size);
  const { entries, decodedOutputBounded } = readDebugEntries(
    bytes,
    image.map,
    fileOffset,
    count,
  );
  const report = {
    artifact,
    format: image.format,
    machine: image.machine,
    directory: {
      rva,
      location: { offset: fileOffset, bytes: size },
      data_directory_location: { offset: debugHeader.headerOffset, bytes: 8 },
    },
    entries,
    coverage: { status: "complete" as const, entries: entries.length },
  };
  return {
    ...report,
    limitations: limitationsFor(report, decodedOutputBounded),
  };
};
