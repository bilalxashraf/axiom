import {
  canonicalJson,
  sha256Bytes,
  type Sha256,
} from "./canonical.ts";

export type MarkdownSpanCategory =
  | "blank"
  | "heading"
  | "list"
  | "code"
  | "prose";

export type MarkdownDisposition =
  | {
      readonly status: "retained_whitespace";
      readonly reason: string;
    }
  | {
      readonly status: "unresolved";
      readonly declaration: string;
      readonly reason: string;
    };

export type MarkdownCoverageSpan = {
  readonly id: string;
  /** Half-open byte offsets into `source.base64`. */
  readonly byte_start: number;
  readonly byte_end: number;
  readonly line: number;
  readonly category: MarkdownSpanCategory;
  readonly sha256: Sha256;
  readonly disposition: MarkdownDisposition;
};

export type MarkdownCoverageMap = {
  readonly format: "AXMAP/0.1";
  readonly source: {
    readonly path: string;
    readonly media_type: "text/markdown";
    readonly byte_length: number;
    readonly sha256: Sha256;
    /** The exact, unmodified input bytes. */
    readonly base64: string;
  };
  readonly generated: {
    readonly language: "Axiom/0.1";
    readonly source_id: string;
    readonly ax_path: string;
  };
  readonly coverage: {
    readonly unit: "byte";
    readonly complete_partition: true;
    readonly spans: readonly MarkdownCoverageSpan[];
  };
};

export type MarkdownImportOptions = {
  readonly sourcePath: string;
  readonly axPath: string;
  readonly mapPath: string;
  readonly sourceId?: string;
};

export type MarkdownImportResult = {
  readonly axSource: string;
  readonly map: MarkdownCoverageMap;
};

type ByteRange = {
  readonly start: number;
  readonly end: number;
  readonly line: number;
};

type Fence = {
  readonly marker: "`" | "~";
  readonly length: number;
};

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SPAN_CATEGORIES = new Set<MarkdownSpanCategory>([
  "blank",
  "heading",
  "list",
  "code",
  "prose",
]);

type UnknownObject = Record<string, unknown>;

export type MarkdownSourceAnchor = {
  readonly name: string;
  readonly hash: string;
  readonly byteLength: number;
  readonly base64: string;
};

export class MarkdownMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownMapError";
  }
}

function mapError(path: string, message: string): never {
  throw new MarkdownMapError(`Invalid AXMAP/0.1 at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): UnknownObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    mapError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    mapError(path, "expected a plain JSON object");
  }
  return value as UnknownObject;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    mapError(path, "expected an array");
  }
  return value;
}

function exactKeys(
  value: UnknownObject,
  expected: readonly string[],
  path: string,
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      mapError(`${path}.${key}`, "unexpected property");
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      mapError(`${path}.${key}`, "missing required property");
    }
  }
}

function stringAt(value: unknown, path: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    mapError(path, nonempty ? "expected a nonempty string" : "expected a string");
  }
  return value;
}

function safeIntegerAt(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum
  ) {
    mapError(path, `expected a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function sha256At(value: unknown, path: string): Sha256 {
  const hash = stringAt(value, path);
  if (!SHA256.test(hash)) {
    mapError(path, "expected a lowercase SHA-256 identifier");
  }
  return hash as Sha256;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function exactBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function lines(bytes: Uint8Array): readonly ByteRange[] {
  const ranges: ByteRange[] = [];
  let start = 0;
  let line = 1;
  let index = 0;

  while (index < bytes.byteLength) {
    const byte = bytes[index];
    if (byte !== 0x0a && byte !== 0x0d) {
      index += 1;
      continue;
    }
    let end = index + 1;
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      end += 1;
    }
    ranges.push({ start, end, line });
    start = end;
    index = end;
    line += 1;
  }

  if (start < bytes.byteLength) {
    ranges.push({ start, end: bytes.byteLength, line });
  }
  return ranges;
}

function withoutLineEnding(value: string): string {
  return value.replace(/(?:\r\n|\r|\n)$/u, "");
}

function openingFence(value: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(value);
  const run = match?.[1];
  if (run === undefined) {
    return undefined;
  }
  return {
    marker: run[0] as "`" | "~",
    length: run.length,
  };
}

function closesFence(value: string, fence: Fence): boolean {
  const candidate = value.replace(/^ {0,3}/u, "");
  let length = 0;
  while (candidate[length] === fence.marker) {
    length += 1;
  }
  return (
    length >= fence.length &&
    candidate.slice(length).trim().length === 0
  );
}

function classify(
  value: string,
  activeFence: Fence | undefined,
): {
  readonly category: MarkdownSpanCategory;
  readonly nextFence: Fence | undefined;
} {
  if (activeFence !== undefined) {
    return {
      category: "code",
      nextFence: closesFence(value, activeFence) ? undefined : activeFence,
    };
  }

  const fence = openingFence(value);
  if (fence !== undefined) {
    return { category: "code", nextFence: fence };
  }
  if (/^[ \t]*$/u.test(value)) {
    return { category: "blank", nextFence: undefined };
  }
  if (/^ {0,3}#{1,6}(?:[ \t]+|$)/u.test(value)) {
    return { category: "heading", nextFence: undefined };
  }
  if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u.test(value)) {
    return { category: "list", nextFence: undefined };
  }
  if (/^(?: {4}|\t)/u.test(value)) {
    return { category: "code", nextFence: undefined };
  }
  return { category: "prose", nextFence: undefined };
}

function unresolvedReason(category: MarkdownSpanCategory): string {
  return (
    `Imported Markdown ${category} may carry instructions, constraints, ` +
    "examples, or context; executable semantics were not inferred automatically."
  );
}

function assertCoverage(
  byteLength: number,
  spans: readonly MarkdownCoverageSpan[],
): void {
  let cursor = 0;
  for (const span of spans) {
    if (span.byte_start !== cursor || span.byte_end <= span.byte_start) {
      throw new Error("Internal error: Markdown coverage is not a byte partition");
    }
    cursor = span.byte_end;
  }
  if (cursor !== byteLength) {
    throw new Error("Internal error: Markdown coverage does not reach end of source");
  }
}

/**
 * Produce a lossless migration draft, not a semantic translation.
 *
 * Every nonblank line is deliberately unresolved. Treating prose as
 * non-normative requires an explicit human or trusted compiler decision; the
 * importer never guesses and thereby never silently drops a possible rule.
 */
export function importMarkdown(
  bytes: Uint8Array,
  options: MarkdownImportOptions,
): MarkdownImportResult {
  const sourceId = options.sourceId ?? "markdown_source";
  if (!IDENTIFIER.test(sourceId)) {
    throw new Error(`Invalid Axiom source identifier ${JSON.stringify(sourceId)}`);
  }

  const spans = analyzeMarkdownCoverage(bytes, sourceId);
  const sourceHash = sha256Bytes(bytes);
  const sourceBase64 = exactBuffer(bytes).toString("base64");
  const declarations = spans.flatMap((span) => {
    if (span.disposition.status !== "unresolved") {
      return [];
    }
    return [
      `unresolved ${span.disposition.declaration} source ${sourceId} ` +
        `bytes ${span.byte_start} ${span.byte_end} hash ${quote(span.sha256)} ` +
        `category ${quote(span.category)} reason ${quote(span.disposition.reason)};`,
    ];
  });
  const axSource = [
    "axiom 0.1;",
    "",
    "// Lossless Markdown migration draft. Resolve every `unresolved` declaration.",
    `source ${sourceId} path ${quote(options.sourcePath)} hash ${quote(sourceHash)} ` +
      `bytes ${bytes.byteLength} base64 ${quote(sourceBase64)} map ${quote(options.mapPath)};`,
    ...(declarations.length === 0 ? [] : ["", ...declarations]),
    "",
  ].join("\n");

  return {
    axSource,
    map: {
      format: "AXMAP/0.1",
      source: {
        path: options.sourcePath,
        media_type: "text/markdown",
        byte_length: bytes.byteLength,
        sha256: sourceHash,
        base64: sourceBase64,
      },
      generated: {
        language: "Axiom/0.1",
        source_id: sourceId,
        ax_path: options.axPath,
      },
      coverage: {
        unit: "byte",
        complete_partition: true,
        spans,
      },
    },
  };
}

/**
 * Deterministically derive the complete byte-partition manifest embedded by
 * the importer and independently recomputed by the strict compiler.
 */
export function analyzeMarkdownCoverage(
  bytes: Uint8Array,
  sourceId = "markdown_source",
): readonly MarkdownCoverageSpan[] {
  if (!IDENTIFIER.test(sourceId)) {
    throw new Error(
      `Invalid Axiom source identifier ${JSON.stringify(sourceId)}`,
    );
  }
  // Preserve the compact v0.1 default while namespacing additional sources so
  // multiple imported Markdown files can coexist in one program.
  const idPrefix = sourceId === "markdown_source" ? "" : `${sourceId}_`;
  const spans: MarkdownCoverageSpan[] = [];
  let activeFence: Fence | undefined;
  for (const [index, range] of lines(bytes).entries()) {
    const slice = bytes.subarray(range.start, range.end);
    const text = withoutLineEnding(UTF8.decode(slice));
    const classified = classify(text, activeFence);
    activeFence = classified.nextFence;
    const ordinal = String(index + 1).padStart(6, "0");
    const declaration = `${idPrefix}md_${ordinal}`;
    const unresolved = classified.category !== "blank";
    spans.push({
      id: `${idPrefix}span_${ordinal}`,
      byte_start: range.start,
      byte_end: range.end,
      line: range.line,
      category: classified.category,
      sha256: sha256Bytes(slice),
      disposition: unresolved
        ? {
            status: "unresolved",
            declaration,
            reason: unresolvedReason(classified.category),
          }
        : {
            status: "retained_whitespace",
            reason:
              "Whitespace is retained byte-for-byte in the coverage source and has no executable semantics.",
          },
    });
  }
  assertCoverage(bytes.byteLength, spans);
  return spans;
}

/**
 * Validate an AXMAP value without trusting any of its derived coverage fields.
 *
 * The embedded source bytes are decoded first, then their hash, length, and
 * complete Markdown partition are recomputed. Exact object keys keep future or
 * misspelled fields from being silently ignored.
 */
export function validateMarkdownCoverageMap(
  value: unknown,
): MarkdownCoverageMap {
  try {
    canonicalJson(value);
  } catch (error) {
    mapError(
      "$",
      `map is not canonical-JSON compatible: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const root = objectAt(value, "$");
  exactKeys(root, ["format", "source", "generated", "coverage"], "$");
  if (root.format !== "AXMAP/0.1") {
    mapError("$.format", 'expected exactly "AXMAP/0.1"');
  }

  const source = objectAt(root.source, "$.source");
  exactKeys(
    source,
    ["path", "media_type", "byte_length", "sha256", "base64"],
    "$.source",
  );
  stringAt(source.path, "$.source.path", true);
  if (source.media_type !== "text/markdown") {
    mapError("$.source.media_type", 'expected exactly "text/markdown"');
  }
  const byteLength = safeIntegerAt(
    source.byte_length,
    "$.source.byte_length",
    0,
  );
  const sourceHash = sha256At(source.sha256, "$.source.sha256");
  const base64 = stringAt(source.base64, "$.source.base64");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) {
    mapError("$.source.base64", "expected canonical RFC 4648 base64");
  }
  if (bytes.byteLength !== byteLength) {
    mapError(
      "$.source.byte_length",
      `declares ${byteLength} bytes but base64 contains ${bytes.byteLength}`,
    );
  }
  if (sha256Bytes(bytes) !== sourceHash) {
    mapError("$.source.sha256", "does not match the embedded source bytes");
  }

  const generated = objectAt(root.generated, "$.generated");
  exactKeys(
    generated,
    ["language", "source_id", "ax_path"],
    "$.generated",
  );
  if (generated.language !== "Axiom/0.1") {
    mapError("$.generated.language", 'expected exactly "Axiom/0.1"');
  }
  const sourceId = stringAt(
    generated.source_id,
    "$.generated.source_id",
    true,
  );
  if (!IDENTIFIER.test(sourceId)) {
    mapError("$.generated.source_id", "expected an Axiom identifier");
  }
  stringAt(generated.ax_path, "$.generated.ax_path", true);

  const coverage = objectAt(root.coverage, "$.coverage");
  exactKeys(
    coverage,
    ["unit", "complete_partition", "spans"],
    "$.coverage",
  );
  if (coverage.unit !== "byte") {
    mapError("$.coverage.unit", 'expected exactly "byte"');
  }
  if (coverage.complete_partition !== true) {
    mapError("$.coverage.complete_partition", "expected exactly true");
  }
  const spans = arrayAt(coverage.spans, "$.coverage.spans");
  spans.forEach((spanValue, index) => {
    const path = `$.coverage.spans[${index}]`;
    const span = objectAt(spanValue, path);
    exactKeys(
      span,
      [
        "id",
        "byte_start",
        "byte_end",
        "line",
        "category",
        "sha256",
        "disposition",
      ],
      path,
    );
    stringAt(span.id, `${path}.id`, true);
    safeIntegerAt(span.byte_start, `${path}.byte_start`, 0);
    safeIntegerAt(span.byte_end, `${path}.byte_end`, 1);
    safeIntegerAt(span.line, `${path}.line`, 1);
    const category = stringAt(span.category, `${path}.category`, true);
    if (!SPAN_CATEGORIES.has(category as MarkdownSpanCategory)) {
      mapError(`${path}.category`, `unknown Markdown category ${JSON.stringify(category)}`);
    }
    sha256At(span.sha256, `${path}.sha256`);

    const dispositionPath = `${path}.disposition`;
    const disposition = objectAt(span.disposition, dispositionPath);
    if (disposition.status === "unresolved") {
      exactKeys(
        disposition,
        ["status", "declaration", "reason"],
        dispositionPath,
      );
      const declaration = stringAt(
        disposition.declaration,
        `${dispositionPath}.declaration`,
        true,
      );
      if (!IDENTIFIER.test(declaration)) {
        mapError(
          `${dispositionPath}.declaration`,
          "expected an Axiom identifier",
        );
      }
      stringAt(disposition.reason, `${dispositionPath}.reason`, true);
    } else if (disposition.status === "retained_whitespace") {
      exactKeys(disposition, ["status", "reason"], dispositionPath);
      stringAt(disposition.reason, `${dispositionPath}.reason`, true);
    } else {
      mapError(
        `${dispositionPath}.status`,
        'expected "unresolved" or "retained_whitespace"',
      );
    }
  });

  const expectedSpans = analyzeMarkdownCoverage(bytes, sourceId);
  if (canonicalJson(spans) !== canonicalJson(expectedSpans)) {
    mapError(
      "$.coverage.spans",
      "does not match the compiler-derived partition of the embedded source bytes",
    );
  }

  return root as unknown as MarkdownCoverageMap;
}

/**
 * Link a validated AXMAP sidecar to the source declaration that must remain in
 * the `.ax` program. This is deliberately separate from map validation so an
 * external sidecar can detect wholesale deletion of the declaration.
 */
export function assertMarkdownMapMatchesSource(
  map: MarkdownCoverageMap,
  source: MarkdownSourceAnchor,
): void {
  if (map.generated.source_id !== source.name) {
    throw new MarkdownMapError(
      `AXMAP source_id ${JSON.stringify(map.generated.source_id)} does not match ` +
        `source declaration ${JSON.stringify(source.name)}`,
    );
  }
  if (map.source.sha256 !== source.hash) {
    throw new MarkdownMapError(
      `AXMAP source hash does not match source declaration ${JSON.stringify(source.name)}`,
    );
  }
  if (map.source.byte_length !== source.byteLength) {
    throw new MarkdownMapError(
      `AXMAP source byte length does not match source declaration ${JSON.stringify(source.name)}`,
    );
  }
  if (map.source.base64 !== source.base64) {
    throw new MarkdownMapError(
      `AXMAP embedded source bytes do not match source declaration ${JSON.stringify(source.name)}`,
    );
  }
}
