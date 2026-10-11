import { createHash } from "node:crypto";

import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { managedFailure } from "./ManagedReaderFailure.js";

/** Per-inspection capacity for eagerly retained metadata and its JSON projection. */
const MAX_METADATA_REPRESENTATION_BYTES = 64 * 1024 * 1024;

interface CachedString {
  readonly value: string;
  readonly encodedBytes: number;
}

/** The layout owns decoding capacity and heap identity for all of its consumers. */
export class ManagedDecodeBudget {
  #remaining = MAX_METADATA_REPRESENTATION_BYTES;
  readonly #strings = new Map<number, CachedString>();
  readonly #digests = new WeakMap<ArrayBufferLike, Map<string, string>>();

  reserve(bytes: number, offset: number | null): void {
    this.admitTransient(bytes, offset);
    this.#remaining -= bytes;
  }

  /** Bound a decoding allocation that is released before the next one; only retained output is reserved. */
  admitTransient(bytes: number, offset: number | null): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw managedFailure(
        "resource-limit",
        "metadata.representation",
        `Managed metadata exceeds the ${String(MAX_METADATA_REPRESENTATION_BYTES)} byte representation budget`,
        offset,
      );
  }

  /** UTF-8 cannot decode to more UTF-16 units than bytes; JSON uses at most six bytes per unit. */
  reserveString(encodedBytes: number, offset: number | null): void {
    this.reserve(encodedBytes * 6 + 2, offset);
  }

  /** Snapshot buffers are immutable within a layout; cache exact backing-buffer ranges. */
  digest(bytes: Buffer, algorithm: "sha256" | "sha1"): string {
    let ranges = this.#digests.get(bytes.buffer);
    if (ranges === undefined) {
      ranges = new Map();
      this.#digests.set(bytes.buffer, ranges);
    }
    const key = `${algorithm}:${String(bytes.byteOffset)}:${String(bytes.byteLength)}`;
    const cached = ranges.get(key);
    if (cached !== undefined) return cached;
    this.reserve(256, null);
    const digest = createHash(algorithm).update(bytes).digest("hex");
    ranges.set(key, digest);
    return digest;
  }

  cachedString(index: number): CachedString | undefined {
    return this.#strings.get(index);
  }

  cacheString(index: number, value: string, encodedBytes: number): void {
    this.#strings.set(index, { value, encodedBytes });
  }
}

const budgets = new WeakMap<ManagedMetadataLayout, ManagedDecodeBudget>();

/** Transfer metadata-root admission capacity to its completed immutable layout. */
export const attachManagedDecodeBudget = (
  layout: ManagedMetadataLayout,
  budget: ManagedDecodeBudget,
): void => {
  budgets.set(layout, budget);
};

/** Share one owner for the lifetime of the admitted layout, including all inspection facets. */
export const managedDecodeBudget = (
  layout: ManagedMetadataLayout,
): ManagedDecodeBudget => {
  let budget = budgets.get(layout);
  if (budget === undefined) {
    budget = new ManagedDecodeBudget();
    budgets.set(layout, budget);
  }
  return budget;
};

/** Exact UTF-8 JSON bytes of a decoded scalar or key, including escapes. */
const jsonBytes = (item: unknown): number =>
  Buffer.byteLength(JSON.stringify(item) ?? "null");

/** Admit repeated values too: shared heap strings still expand at the JSON boundary. */
export const admitManagedProjection = <Value>(
  value: Value,
  budget: ManagedDecodeBudget = new ManagedDecodeBudget(),
): Value => {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      budget.reserve(item.length + 2, null);
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      budget.reserve(2, null);
      for (const key of Object.keys(item)) {
        budget.reserve(jsonBytes(key) + 2, null);
        visit(Reflect.get(item, key));
      }
    } else {
      budget.reserve(jsonBytes(item), null);
    }
  };
  visit(value);
  return value;
};
