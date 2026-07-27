import { createHash } from "node:crypto";

/**
 * The data domain accepted by Axiom's wire format and evidence hashes.
 *
 * Objects are intentionally readonly at the type level. Canonicalization never
 * mutates its input.
 */
export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type Sha256 = `sha256:${string}`;
export const MAX_CANONICAL_JSON_DEPTH = 256;

export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
    return `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("JSON numbers must be finite", path);
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(
      "Axiom JSON numbers must be safe integers",
      path,
    );
  }

  // Normalize negative zero because JSON has no signed zero.
  if (Object.is(value, -0)) {
    return "0";
  }
  return String(value);
}

/**
 * Axiom Text is a sequence of Unicode scalar values, not an arbitrary
 * JavaScript UTF-16 string. Rejecting unpaired surrogates is required for
 * cross-runtime hashes: some runtimes preserve them as escaped code units,
 * while others replace or reject them during UTF-8 encoding.
 */
export function assertUnicodeScalarString(
  value: string,
  path = "$",
): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new CanonicalJsonError(
          "Strings must contain only Unicode scalar values",
          path,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalJsonError(
        "Strings must contain only Unicode scalar values",
        path,
      );
    }
  }
}

export function unicodeScalarLength(value: string): number {
  assertUnicodeScalarString(value);
  return Array.from(value).length;
}

export function compareUnicodeScalars(left: string, right: string): number {
  assertUnicodeScalarString(left);
  assertUnicodeScalarString(right);
  const leftScalars = left[Symbol.iterator]();
  const rightScalars = right[Symbol.iterator]();
  while (true) {
    const leftNext = leftScalars.next();
    const rightNext = rightScalars.next();
    if (leftNext.done === true || rightNext.done === true) {
      if (leftNext.done === rightNext.done) {
        return 0;
      }
      return leftNext.done === true ? -1 : 1;
    }
    const leftCodePoint = leftNext.value.codePointAt(0) as number;
    const rightCodePoint = rightNext.value.codePointAt(0) as number;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
}

function canonicalString(value: string, path: string): string {
  assertUnicodeScalarString(value, path);
  return JSON.stringify(value);
}

function serialize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new CanonicalJsonError(
      `JSON nesting exceeds ${MAX_CANONICAL_JSON_DEPTH}`,
      path,
    );
  }
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value, path);
    case "string":
      return canonicalString(value, path);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new CanonicalJsonError(
        `Values of type ${typeof value} are not JSON-compatible`,
        path,
      );
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError("Cyclic values cannot be canonicalized", path);
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError(
            "Sparse arrays are not JSON-compatible",
            childPath(path, index),
          );
        }
        parts.push(
          serialize(
            value[index],
            childPath(path, index),
            ancestors,
            depth + 1,
          ),
        );
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "Only plain objects are JSON-compatible",
        path,
      );
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (
      symbols.some((symbol) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
        return descriptor?.enumerable === true;
      })
    ) {
      throw new CanonicalJsonError(
        "Enumerable symbol keys are not JSON-compatible",
        path,
      );
    }

    const keys = Object.keys(value).sort(compareUnicodeScalars);
    const parts: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        throw new CanonicalJsonError("Object changed during serialization", path);
      }
      if (!("value" in descriptor)) {
        throw new CanonicalJsonError(
          "Accessor properties are not JSON-compatible",
          childPath(path, key),
        );
      }
      parts.push(
        `${canonicalString(key, childPath(path, key))}:${serialize(
          descriptor.value,
          childPath(path, key),
          ancestors,
          depth + 1,
        )}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialize a JSON-compatible value with stable object-key ordering.
 *
 * Unlike JSON.stringify, this function rejects undefined values, sparse
 * arrays, accessors, custom prototypes, cycles, and non-finite numbers rather
 * than silently changing their meaning.
 */
export function canonicalJson(value: JsonValue | unknown): string {
  return serialize(value, "$", new Set<object>(), 0);
}

export function canonicalJsonBytes(value: JsonValue | unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Return a detached, canonical in-memory JSON value (including `-0` -> `0`). */
export function normalizeJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function freezeJsonValue(value: JsonValue): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJsonValue(item);
    }
  } else {
    for (const item of Object.values(value)) {
      freezeJsonValue(item);
    }
  }
  Object.freeze(value);
}

/** Return a detached, canonical, deeply frozen JSON snapshot. */
export function immutableJsonSnapshot(value: unknown): JsonValue {
  const snapshot = normalizeJsonValue(value);
  freezeJsonValue(snapshot);
  return snapshot;
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  canonicalJson(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

export interface ParseJsonOptions {
  readonly requireCanonical?: boolean;
  /** Defaults to true because duplicate names are not interoperable data. */
  readonly rejectDuplicateKeys?: boolean;
}

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(text[index] ?? "")) {
      index += 1;
    }
  };
  const scanString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(text.slice(start, index)) as string;
      }
    }
    throw new CanonicalJsonError("Invalid JSON string");
  };
  const scanValue = (depth = 0): void => {
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new CanonicalJsonError(
        `JSON nesting exceeds ${MAX_CANONICAL_JSON_DEPTH}`,
      );
    }
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = scanString();
        if (keys.has(key)) {
          throw new CanonicalJsonError(
            `JSON object contains duplicate key ${JSON.stringify(key)}`,
          );
        }
        keys.add(key);
        skipWhitespace();
        index += 1; // Validated JSON guarantees ':'.
        scanValue(depth + 1);
        skipWhitespace();
        const separator = text[index];
        index += 1;
        if (separator === "}") {
          return;
        }
        skipWhitespace();
      }
      return;
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        scanValue(depth + 1);
        skipWhitespace();
        const separator = text[index];
        index += 1;
        if (separator === "]") {
          return;
        }
      }
      return;
    }
    if (character === '"') {
      scanString();
      return;
    }
    while (
      index < text.length &&
      !/[\u0009\u000a\u000d\u0020,\]}]/u.test(text[index] as string)
    ) {
      index += 1;
    }
  };
  scanValue();
  skipWhitespace();
  if (index !== text.length) {
    throw new CanonicalJsonError("Invalid trailing JSON data");
  }
}

/**
 * Parse JSON while retaining Axiom's stricter value-domain guarantees.
 */
export function parseJson(
  text: string,
  options: ParseJsonOptions = {},
): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CanonicalJsonError(`Invalid JSON: ${detail}`);
  }
  if (options.rejectDuplicateKeys !== false) {
    assertNoDuplicateJsonKeys(text);
  }
  const canonical = canonicalJson(value);
  if (options.requireCanonical === true && canonical !== text) {
    throw new CanonicalJsonError("JSON is valid but not canonically encoded");
  }
  return JSON.parse(canonical) as JsonValue;
}

export function sha256Text(text: string): Sha256 {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function sha256Bytes(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalHash(value: JsonValue | unknown): Sha256 {
  return sha256Text(canonicalJson(value));
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
