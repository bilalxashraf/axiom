import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";

import {
  canonicalJson,
  immutableJsonSnapshot,
  parseJson,
  unicodeScalarLength,
} from "./canonical.ts";
import type { JsonValue } from "./ir.ts";
import { ReplayError } from "./errors.ts";

export const DEFAULT_MAX_LEDGER_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_LEDGER_ENTRIES = 100_000;
export const DEFAULT_MAX_LEDGER_LINE_BYTES = 8 * 1024 * 1024;

export interface LedgerReadOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxLineBytes?: number;
}

export type LedgerEntry = {
  readonly sequence: number;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly previous: string;
  readonly hash: string;
};

type UnsignedLedgerEntry = Omit<LedgerEntry, "hash">;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class Ledger {
  readonly #entries: LedgerEntry[] = [];
  readonly #journal:
    | {
        readonly descriptor: number;
        readonly path: string;
      }
    | undefined;
  #closed = false;

  constructor(
    journal?: {
      readonly descriptor: number;
      readonly path: string;
    },
  ) {
    this.#journal = journal;
  }

  /**
   * Create a new append-only write-ahead ledger. `wx` refuses to overwrite an
   * existing audit log. Every append is flushed before control returns.
   */
  static createDurable(path: string): Ledger {
    const descriptor = openSync(path, "wx", 0o600);
    return new Ledger({ descriptor, path });
  }

  get durablePath(): string | undefined {
    return this.#journal?.path;
  }

  get entries(): readonly LedgerEntry[] {
    return Object.freeze(this.#entries.slice());
  }

  get root(): string {
    return this.#entries.at(-1)?.hash ?? "sha256:genesis";
  }

  append(kind: string, payload: JsonValue): LedgerEntry {
    if (this.#closed) {
      throw new Error("Cannot append to a closed ledger");
    }
    let kindLength: number;
    try {
      kindLength = unicodeScalarLength(kind);
    } catch {
      throw new RangeError(
        "Ledger entry kind must contain only Unicode scalar values",
      );
    }
    if (kindLength === 0 || kindLength > 128) {
      throw new RangeError(
        "Ledger entry kind must contain 1-128 Unicode scalar values",
      );
    }
    const payloadSnapshot = immutableJsonSnapshot(payload);
    const unsigned: UnsignedLedgerEntry = {
      sequence: this.#entries.length,
      kind,
      payload: payloadSnapshot,
      previous: this.root,
    };
    const entry: LedgerEntry = Object.freeze({
      ...unsigned,
      hash: sha256(canonicalJson(unsigned as unknown as JsonValue)),
    });
    if (this.#journal !== undefined) {
      const bytes = Buffer.from(
        `${canonicalJson(entry as unknown as JsonValue)}\n`,
        "utf8",
      );
      let offset = 0;
      while (offset < bytes.byteLength) {
        offset += writeSync(
          this.#journal.descriptor,
          bytes,
          offset,
          bytes.byteLength - offset,
        );
      }
      fsyncSync(this.#journal.descriptor);
    }
    this.#entries.push(entry);
    return entry;
  }

  async write(path: string): Promise<void> {
    if (this.#journal !== undefined) {
      throw new Error(
        `Ledger is already durably journaled at ${JSON.stringify(this.#journal.path)}`,
      );
    }
    const body =
      this.#entries.length === 0
        ? ""
        : `${this.#entries.map((entry) => canonicalJson(entry as unknown as JsonValue)).join("\n")}\n`;
    await writeFile(path, body, "utf8");
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#journal !== undefined) {
      fsyncSync(this.#journal.descriptor);
      closeSync(this.#journal.descriptor);
    }
    this.#closed = true;
  }

  static async read(
    path: string,
    options: LedgerReadOptions = {},
  ): Promise<Ledger> {
    const maxBytes = positiveLimit(
      options.maxBytes,
      DEFAULT_MAX_LEDGER_BYTES,
      "maxBytes",
    );
    const maxEntries = positiveLimit(
      options.maxEntries,
      DEFAULT_MAX_LEDGER_ENTRIES,
      "maxEntries",
    );
    const maxLineBytes = positiveLimit(
      options.maxLineBytes,
      DEFAULT_MAX_LEDGER_LINE_BYTES,
      "maxLineBytes",
    );
    const metadata = await stat(path);
    if (metadata.size > maxBytes) {
      throw new ReplayError(
        "AX3012",
        `Ledger is ${metadata.size} bytes, exceeding the ${maxBytes}-byte read limit`,
      );
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) {
      throw new ReplayError(
        "AX3012",
        `Ledger is ${bytes.byteLength} bytes, exceeding the ${maxBytes}-byte read limit`,
      );
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ReplayError("AX3013", "Ledger is not valid UTF-8");
    }
    if (body.length !== 0 && !body.endsWith("\n")) {
      throw new ReplayError(
        "AX3014",
        "Canonical ledger files must end with one newline",
      );
    }
    const ledger = new Ledger();
    const lines = body.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line === "") {
        if (index !== lines.length - 1) {
          throw new ReplayError(
            "AX3014",
            `Canonical ledger files cannot contain a blank line at ${index + 1}`,
          );
        }
        continue;
      }
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > maxLineBytes) {
        throw new ReplayError(
          "AX3015",
          `Ledger line ${index + 1} is ${lineBytes} bytes, exceeding the ${maxLineBytes}-byte line limit`,
        );
      }
      if (ledger.#entries.length >= maxEntries) {
        throw new ReplayError(
          "AX3016",
          `Ledger exceeds the ${maxEntries}-entry read limit`,
        );
      }
      const value = parseJson(line, { requireCanonical: true });
      if (
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
      ) {
        throw new ReplayError(
          "AX3017",
          `Ledger line ${index + 1} must be an entry object`,
        );
      }
      const object = value as Readonly<Record<string, JsonValue>>;
      const keys = Object.keys(object).sort();
      const expectedKeys = [
        "hash",
        "kind",
        "payload",
        "previous",
        "sequence",
      ];
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
      ) {
        throw new ReplayError(
          "AX3018",
          `Ledger line ${index + 1} has missing or unexpected entry fields`,
        );
      }
      if (
        typeof object.sequence !== "number" ||
        !Number.isSafeInteger(object.sequence) ||
        object.sequence < 0 ||
        typeof object.kind !== "string" ||
        object.kind.length === 0 ||
        object.kind.length > 128 ||
        typeof object.previous !== "string" ||
        !/^sha256:(?:genesis|[0-9a-f]{64})$/u.test(object.previous) ||
        typeof object.hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(object.hash)
      ) {
        throw new ReplayError(
          "AX3019",
          `Ledger line ${index + 1} has an invalid field type or value`,
        );
      }
      const parsed = object as unknown as LedgerEntry;
      if (parsed.sequence !== ledger.#entries.length) {
        throw new ReplayError("AX3001", `Ledger sequence mismatch on line ${index + 1}`);
      }
      const expectedPrevious = ledger.root;
      if (parsed.previous !== expectedPrevious) {
        throw new ReplayError("AX3002", `Ledger hash chain diverges on line ${index + 1}`);
      }
      const unsigned: UnsignedLedgerEntry = {
        sequence: parsed.sequence,
        kind: parsed.kind,
        payload: parsed.payload,
        previous: parsed.previous,
      };
      const expectedHash = sha256(canonicalJson(unsigned as unknown as JsonValue));
      if (parsed.hash !== expectedHash) {
        throw new ReplayError("AX3003", `Ledger entry hash is invalid on line ${index + 1}`);
      }
      ledger.#entries.push(
        immutableJsonSnapshot(parsed) as unknown as LedgerEntry,
      );
    }
    return ledger;
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

export type ReplayEffect = {
  readonly request: JsonValue;
  readonly response: JsonValue;
};

export function effectsFromLedger(ledger: Ledger): ReplayEffect[] {
  const entries = ledger.entries;
  if (entries[0]?.kind !== "run") {
    throw new ReplayError("AX3023", "Replay ledger must begin with one run entry");
  }
  const terminals = entries.filter(
    (entry) => entry.kind === "success" || entry.kind === "failure",
  );
  if (
    terminals.length !== 1 ||
    entries.at(-1) !== terminals[0]
  ) {
    throw new ReplayError(
      "AX3024",
      "Replay ledger must end with exactly one success or failure entry",
    );
  }
  const allowedKinds = new Set([
    "run",
    "effect_intent",
    "effect",
    "obligation",
    "success",
    "failure",
  ]);
  for (const [index, entry] of entries.entries()) {
    if (!allowedKinds.has(entry.kind)) {
      throw new ReplayError(
        "AX3025",
        `Unknown replay ledger entry kind ${JSON.stringify(entry.kind)} at sequence ${index}`,
      );
    }
    if (entry.kind === "run" && index !== 0) {
      throw new ReplayError("AX3026", "Replay ledger contains more than one run entry");
    }
  }
  const effects: ReplayEffect[] = [];
  let intent: JsonValue | undefined;
  for (const entry of entries) {
    if (entry.kind === "effect_intent") {
      const payload = entry.payload;
      if (
        intent !== undefined ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload !== "object" ||
        Object.keys(payload).length !== 1 ||
        !("request" in payload)
      ) {
        throw new ReplayError(
          "AX3020",
          "Malformed or overlapping effect intent in ledger",
        );
      }
      intent = payload.request as JsonValue;
      continue;
    }
    if (entry.kind !== "effect") {
      continue;
    }
    const payload = entry.payload;
    if (
      intent === undefined ||
      payload === null ||
      Array.isArray(payload) ||
      typeof payload !== "object" ||
      Object.keys(payload).length !== 2 ||
      !("request" in payload) ||
      !("response" in payload)
    ) {
      throw new ReplayError("AX3004", "Malformed effect entry in ledger");
    }
    if (
      canonicalJson(intent) !==
      canonicalJson(payload.request as JsonValue)
    ) {
      throw new ReplayError(
        "AX3021",
        "Effect outcome does not match its preceding intent",
      );
    }
    effects.push({
      request: payload.request as JsonValue,
      response: payload.response as JsonValue,
    });
    intent = undefined;
  }
  if (intent !== undefined) {
    throw new ReplayError(
      "AX3022",
      "Ledger ends with an uncertain effect intent and no recorded outcome",
    );
  }
  return effects;
}
