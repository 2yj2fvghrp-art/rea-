import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { PACKAGE_METADATA } from "../generatedPackageMetadata.js";

/** A native resource remains opaque until the addon validates its object tag. */
export const windowsHandleSchema = z.custom<object>(
  (value): value is object =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);

/** Observed identity of an opened local NTFS object. */
export const windowsFileIdentitySchema = z.strictObject({
  requestedPath: z.string(),
  finalPath: z.string(),
  filesystem: z.literal("NTFS"),
  volumeSerial: z.string().regex(/^[a-f0-9]{16}$/u),
  fileId: z.string().regex(/^[a-f0-9]{32}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  directory: z.boolean(),
});

/** Metadata bound to one packaged Windows x64 Node-API artifact. */
export const windowsNativeManifestSchema = z.strictObject({
  packageVersion: z.string(),
  platform: z.literal("win32"),
  architecture: z.literal("x64"),
  abiVersion: z.literal(1),
  nodeApiVersion: z.literal(8),
  artifact: z.literal("rea-windows-x64.node"),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const inspectionSchema = z.strictObject({
  abiVersion: z.literal(1),
  nodeApiVersion: z.literal(8),
  architecture: z.literal("x64"),
  filesystem: windowsFileIdentitySchema,
  privateDacl: z.literal(true),
  atomicJobAssignment: z.literal(true),
  killOnOwnerClose: z.literal(true),
  protocolStdin: z.boolean().optional(),
  /** Absent from artifacts built before owned Job Object commit limits. */
  jobMemoryLimit: z.literal(true).optional(),
  /** Older compatible artifacts still support other controls, but not capture. */
  windowCapture: z.literal(true).optional(),
});

/** Screenshot capture does not require private runtime or Job Object readiness. */
const windowCaptureInspectionSchema = z.strictObject({
  abiVersion: z.literal(1),
  nodeApiVersion: z.literal(8),
  architecture: z.literal("x64"),
  windowCapture: z.literal(true),
});

type NativeCall = (
  operation: string,
  arguments_: readonly unknown[],
) => unknown;
const bindingSchema = z.strictObject({
  call: z.custom<NativeCall>(
    (value): value is NativeCall => typeof value === "function",
  ),
});

/** Validated native operations and the observations establishing readiness. */
export interface WindowsNativeAuthority {
  readonly call: NativeCall;
  readonly inspection: z.infer<typeof inspectionSchema>;
}

/** Native authority admitted only for target-bound selected-window capture. */
export interface WindowsWindowCaptureAuthority {
  readonly call: NativeCall;
}

/** Availability of the bundled native implementation, including load failures. */
export type WindowsNativeLoadResult =
  | { readonly available: true; readonly authority: WindowsNativeAuthority }
  | {
      readonly available: false;
      readonly reason: string;
      /** Only a failed native invocation can recover on a later query. */
      readonly retryable?: true;
    };

/** Availability of the independent selected-window capture facet. */
export type WindowsWindowCaptureLoadResult =
  | {
      readonly available: true;
      readonly authority: WindowsWindowCaptureAuthority;
    }
  | {
      readonly available: false;
      readonly reason: string;
      /** Only a failed native invocation can recover on a later query. */
      readonly retryable?: true;
    };

/** Trusted package reads and module loading, replaceable in loader tests. */
export interface WindowsNativeLoadHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeApiVersion: string | undefined;
  readonly packageVersion: string;
  readManifest(): unknown;
  readArtifact(): Buffer;
  loadArtifact(): unknown;
}

type WindowsNativeBindingLoadResult =
  | { readonly available: true; readonly call: NativeCall }
  | { readonly available: false; readonly reason: string };

/** Admit the packaged artifact before selecting a narrow native capability. */
const loadWindowsNativeBinding = (
  host: WindowsNativeLoadHost,
): WindowsNativeBindingLoadResult => {
  if (host.platform !== "win32" || host.architecture !== "x64")
    return {
      available: false,
      reason: "REA Windows native controls require a Windows x64 host.",
    };
  try {
    const manifest = windowsNativeManifestSchema.parse(host.readManifest());
    if (manifest.packageVersion !== host.packageVersion)
      throw new Error("Windows native artifact belongs to another REA version");
    const nodeApiVersion = Number(host.nodeApiVersion);
    if (!Number.isSafeInteger(nodeApiVersion) || nodeApiVersion < 8)
      throw new Error("Windows native artifact requires Node-API 8 or newer");
    const artifact = host.readArtifact();
    if (
      createHash("sha256").update(artifact).digest("hex") !==
      manifest.artifactSha256
    )
      throw new Error(
        "Windows native artifact SHA-256 does not match package metadata",
      );
    assertWindowsX64Artifact(artifact);
    return {
      available: true,
      call: bindingSchema.parse(host.loadArtifact()).call,
    };
  } catch (cause: unknown) {
    return {
      available: false,
      reason: `REA Windows native controls are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

/** Validate compatibility and artifact identity before invoking the native addon. */
export const loadWindowsNativeAuthority = (
  host: WindowsNativeLoadHost,
): WindowsNativeLoadResult => {
  const binding = loadWindowsNativeBinding(host);
  if (!binding.available) return binding;
  try {
    let observed: unknown;
    try {
      observed = binding.call("inspect", []);
    } catch (cause: unknown) {
      return {
        available: false,
        retryable: true,
        reason: `REA Windows native self-test failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const inspection = inspectionSchema.parse(observed);
    return { available: true, authority: { call: binding.call, inspection } };
  } catch (cause: unknown) {
    return {
      available: false,
      reason: `REA Windows native controls are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

/** Load screenshot capture without running unrelated private-runtime or Job probes. */
export const loadWindowsWindowCaptureAuthority = (
  host: WindowsNativeLoadHost,
): WindowsWindowCaptureLoadResult => {
  const binding = loadWindowsNativeBinding(host);
  if (!binding.available) return binding;
  try {
    let observed: unknown;
    try {
      observed = binding.call("inspect_window_capture", []);
    } catch (cause: unknown) {
      const unsupported = z
        .object({ win32Code: z.literal(87) })
        .safeParse(cause).success;
      return {
        available: false,
        ...(unsupported ? {} : { retryable: true as const }),
        reason: unsupported
          ? "The loaded Windows addon does not support selected-window capture; rebuild or install the matching native artifact."
          : `REA Windows selected-window capture self-test failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    windowCaptureInspectionSchema.parse(observed);
    return { available: true, authority: { call: binding.call } };
  } catch (cause: unknown) {
    return {
      available: false,
      reason: `REA Windows selected-window capture is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

const assertWindowsX64Artifact = (bytes: Buffer): void => {
  if (bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ")
    throw new Error("Windows native artifact is not a PE image");
  const offset = bytes.readUInt32LE(0x3c);
  if (
    offset > bytes.length - 26 ||
    bytes.toString("latin1", offset, offset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(offset + 4) !== 0x8664 ||
    bytes.readUInt16LE(offset + 24) !== 0x20b
  )
    throw new Error("Windows native artifact is not a Windows x64 PE32+ image");
};

const systemWindowsNativeLoadHost = (): WindowsNativeLoadHost => ({
  platform: process.platform,
  architecture: process.arch,
  nodeApiVersion: process.versions.napi,
  packageVersion: PACKAGE_METADATA.version,
  readManifest: () => {
    const encoded = readFileSync(
      new URL("../../native/windows/build/manifest.json", import.meta.url),
      "utf8",
    );
    const value: unknown = JSON.parse(encoded);
    return value;
  },
  readArtifact: () =>
    readFileSync(
      new URL(
        "../../native/windows/build/rea-windows-x64.node",
        import.meta.url,
      ),
    ),
  loadArtifact: () => {
    const value: unknown = createRequire(import.meta.url)(
      fileURLToPath(
        new URL(
          "../../native/windows/build/rea-windows-x64.node",
          import.meta.url,
        ),
      ),
    );
    return value;
  },
});

let cached: WindowsNativeLoadResult | undefined;
let cachedWindowCapture: WindowsWindowCaptureLoadResult | undefined;

/** Cache stable admission; let a later query retry failed owned inspection. */
export const systemWindowsNativeAuthority = (): WindowsNativeLoadResult => {
  if (cached?.available === false && cached.retryable === true)
    cached = undefined;
  cached ??= loadWindowsNativeAuthority(systemWindowsNativeLoadHost());
  return cached;
};

/** Cache selected-window capture separately from unrelated native controls. */
export const systemWindowsWindowCaptureAuthority =
  (): WindowsWindowCaptureLoadResult => {
    if (
      cachedWindowCapture?.available === false &&
      cachedWindowCapture.retryable === true
    )
      cachedWindowCapture = undefined;
    cachedWindowCapture ??= loadWindowsWindowCaptureAuthority(
      systemWindowsNativeLoadHost(),
    );
    return cachedWindowCapture;
  };

/** Require the verified backend when an operation depends on native authority. */
export const requireWindowsNativeAuthority = (): WindowsNativeAuthority => {
  const loaded = systemWindowsNativeAuthority();
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.authority;
};

/** Require the independently verified native screenshot capability. */
export const requireWindowsWindowCaptureAuthority =
  (): WindowsWindowCaptureAuthority => {
    const loaded = systemWindowsWindowCaptureAuthority();
    if (!loaded.available) throw new Error(loaded.reason);
    return loaded.authority;
  };
