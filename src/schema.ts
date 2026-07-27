import {
  canonicalEqual,
  canonicalJson,
  unicodeScalarLength,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "./canonical.ts";

export interface AnySchema {
  readonly kind: "any";
}

export interface NullSchema {
  readonly kind: "null";
}

export interface BooleanSchema {
  readonly kind: "boolean";
}

export interface StringSchema {
  readonly kind: "string";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface NumberSchema {
  readonly kind: "number";
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface LiteralSchema {
  readonly kind: "literal";
  readonly value: JsonPrimitive;
}

export interface EnumSchema {
  readonly kind: "enum";
  readonly values: readonly JsonPrimitive[];
}

export interface ArraySchema {
  readonly kind: "array";
  readonly items: CompactSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface TupleSchema {
  readonly kind: "tuple";
  readonly items: readonly CompactSchema[];
  readonly rest?: CompactSchema;
}

export interface RecordFieldSchema {
  readonly name: string;
  readonly schema: CompactSchema;
  readonly required: boolean;
}

export interface RecordSchema {
  readonly kind: "record";
  readonly fields: readonly RecordFieldSchema[];
  /**
   * Omitted and false both mean a closed record. true permits any JSON value;
   * a schema validates every additional field.
   */
  readonly additional?: boolean | CompactSchema;
}

export interface UnionSchema {
  readonly kind: "union";
  readonly variants: readonly CompactSchema[];
}

export interface RefSchema {
  readonly kind: "ref";
  readonly name: string;
}

/**
 * A provider-neutral schema AST. It deliberately models the deterministic
 * JSON subset needed at an inference boundary instead of depending on any
 * vendor's "structured output" dialect.
 */
export type CompactSchema =
  | AnySchema
  | NullSchema
  | BooleanSchema
  | StringSchema
  | NumberSchema
  | LiteralSchema
  | EnumSchema
  | ArraySchema
  | TupleSchema
  | RecordSchema
  | UnionSchema
  | RefSchema;

export type SchemaDefinitions = Readonly<Record<string, CompactSchema>>;

/**
 * The only regular-language pattern in the certified profile. Arbitrary
 * host-regex syntax is intentionally excluded because engines differ and
 * backtracking expressions can be a denial-of-service primitive.
 */
export const CANONICAL_BASE64_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

export const schema = {
  any(): AnySchema {
    return { kind: "any" };
  },
  null(): NullSchema {
    return { kind: "null" };
  },
  boolean(): BooleanSchema {
    return { kind: "boolean" };
  },
  string(options: Omit<StringSchema, "kind"> = {}): StringSchema {
    return { kind: "string", ...options };
  },
  number(options: Omit<NumberSchema, "kind"> = {}): NumberSchema {
    return { kind: "number", ...options };
  },
  integer(
    options: Omit<NumberSchema, "kind" | "integer"> = {},
  ): NumberSchema {
    return { kind: "number", integer: true, ...options };
  },
  literal(value: JsonPrimitive): LiteralSchema {
    return { kind: "literal", value };
  },
  enum(values: readonly JsonPrimitive[]): EnumSchema {
    return { kind: "enum", values };
  },
  array(
    items: CompactSchema,
    options: Omit<ArraySchema, "kind" | "items"> = {},
  ): ArraySchema {
    return { kind: "array", items, ...options };
  },
  tuple(
    items: readonly CompactSchema[],
    rest?: CompactSchema,
  ): TupleSchema {
    return rest === undefined
      ? { kind: "tuple", items }
      : { kind: "tuple", items, rest };
  },
  field(
    name: string,
    fieldSchema: CompactSchema,
    required = true,
  ): RecordFieldSchema {
    return { name, schema: fieldSchema, required };
  },
  record(
    fields: readonly RecordFieldSchema[],
    additional?: boolean | CompactSchema,
  ): RecordSchema {
    return additional === undefined
      ? { kind: "record", fields }
      : { kind: "record", fields, additional };
  },
  union(variants: readonly CompactSchema[]): UnionSchema {
    return { kind: "union", variants };
  },
  ref(name: string): RefSchema {
    return { kind: "ref", name };
  },
} as const;

export class SchemaDefinitionError extends TypeError {
  readonly path: string;

  constructor(message: string, path = "$schema") {
    super(`${message} at ${path}`);
    this.name = "SchemaDefinitionError";
    this.path = path;
  }
}

export interface SchemaIssue {
  readonly path: string;
  readonly code:
    | "invalid_json"
    | "type"
    | "literal"
    | "enum"
    | "minimum"
    | "maximum"
    | "min_length"
    | "max_length"
    | "pattern"
    | "min_items"
    | "max_items"
    | "tuple_length"
    | "required"
    | "additional"
    | "union"
    | "unknown_ref"
    | "max_depth";
  readonly message: string;
}

export type SchemaValidation =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

export interface SchemaValidationOptions {
  readonly definitions?: SchemaDefinitions;
  readonly maxDepth?: number;
  readonly maxIssues?: number;
}

function valuePath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
    return `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonNegativeInteger(
  value: number | undefined,
  name: string,
  path: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new SchemaDefinitionError(
      `${name} must be a non-negative safe integer`,
      path,
    );
  }
}

/**
 * Validate the schema itself. The compiler can call this once and the runtime
 * can then validate arbitrarily many values without trusting a provider.
 */
export function assertWellFormedSchema(
  root: CompactSchema,
  definitions: SchemaDefinitions = {},
): void {
  const active = new Set<CompactSchema>();

  const visit = (current: CompactSchema, path: string): void => {
    if (active.has(current)) {
      throw new SchemaDefinitionError(
        "Schema objects must not contain JavaScript reference cycles; use ref",
        path,
      );
    }
    active.add(current);
    try {
      switch (current.kind) {
        case "any":
        case "null":
        case "boolean":
          return;
        case "string": {
          requireNonNegativeInteger(current.minLength, "minLength", path);
          requireNonNegativeInteger(current.maxLength, "maxLength", path);
          if (
            current.minLength !== undefined &&
            current.maxLength !== undefined &&
            current.minLength > current.maxLength
          ) {
            throw new SchemaDefinitionError(
              "minLength cannot exceed maxLength",
              path,
            );
          }
          if (current.pattern !== undefined) {
            if (current.pattern !== CANONICAL_BASE64_PATTERN) {
              throw new SchemaDefinitionError(
                "Certified schemas permit only the canonical-base64 pattern; arbitrary host regex is not portable or bounded",
                path,
              );
            }
          }
          return;
        }
        case "number":
          if (
            current.minimum !== undefined &&
            !Number.isSafeInteger(current.minimum)
          ) {
            throw new SchemaDefinitionError(
              "minimum must be a safe integer",
              path,
            );
          }
          if (
            current.maximum !== undefined &&
            !Number.isSafeInteger(current.maximum)
          ) {
            throw new SchemaDefinitionError(
              "maximum must be a safe integer",
              path,
            );
          }
          if (
            current.minimum !== undefined &&
            current.maximum !== undefined &&
            current.minimum > current.maximum
          ) {
            throw new SchemaDefinitionError(
              "minimum cannot exceed maximum",
              path,
            );
          }
          return;
        case "literal":
          canonicalJson(current.value);
          return;
        case "enum": {
          if (current.values.length === 0) {
            throw new SchemaDefinitionError("enum cannot be empty", path);
          }
          const seen = new Set<string>();
          for (const [index, value] of current.values.entries()) {
            const encoded = canonicalJson(value);
            if (seen.has(encoded)) {
              throw new SchemaDefinitionError(
                "enum values must be unique",
                `${path}.values[${index}]`,
              );
            }
            seen.add(encoded);
          }
          return;
        }
        case "array":
          requireNonNegativeInteger(current.minItems, "minItems", path);
          requireNonNegativeInteger(current.maxItems, "maxItems", path);
          if (
            current.minItems !== undefined &&
            current.maxItems !== undefined &&
            current.minItems > current.maxItems
          ) {
            throw new SchemaDefinitionError(
              "minItems cannot exceed maxItems",
              path,
            );
          }
          visit(current.items, `${path}.items`);
          return;
        case "tuple":
          for (const [index, item] of current.items.entries()) {
            visit(item, `${path}.items[${index}]`);
          }
          if (current.rest !== undefined) {
            visit(current.rest, `${path}.rest`);
          }
          return;
        case "record": {
          const names = new Set<string>();
          for (const [index, field] of current.fields.entries()) {
            if (field.name.length === 0) {
              throw new SchemaDefinitionError(
                "Record field names cannot be empty",
                `${path}.fields[${index}]`,
              );
            }
            if (names.has(field.name)) {
              throw new SchemaDefinitionError(
                `Duplicate record field ${JSON.stringify(field.name)}`,
                `${path}.fields[${index}]`,
              );
            }
            names.add(field.name);
            visit(field.schema, `${path}.fields[${index}].schema`);
          }
          if (
            typeof current.additional === "object" &&
            current.additional !== null
          ) {
            visit(current.additional, `${path}.additional`);
          }
          return;
        }
        case "union":
          if (current.variants.length < 2) {
            throw new SchemaDefinitionError(
              "A union needs at least two variants",
              path,
            );
          }
          for (const [index, variant] of current.variants.entries()) {
            visit(variant, `${path}.variants[${index}]`);
          }
          return;
        case "ref":
          if (current.name.length === 0) {
            throw new SchemaDefinitionError(
              "Reference names cannot be empty",
              path,
            );
          }
          if (!Object.hasOwn(definitions, current.name)) {
            throw new SchemaDefinitionError(
              `Unknown schema reference ${JSON.stringify(current.name)}`,
              path,
            );
          }
          return;
      }
    } finally {
      active.delete(current);
    }
  };

  for (const [name, definition] of Object.entries(definitions)) {
    if (name.length === 0) {
      throw new SchemaDefinitionError("Definition names cannot be empty");
    }
    visit(definition, `$defs[${JSON.stringify(name)}]`);
  }
  visit(root, "$schema");
}

function jsonCompatibilityIssue(value: unknown): SchemaIssue | undefined {
  try {
    canonicalJson(value);
    return undefined;
  } catch (error) {
    return {
      path: "$",
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateSchema(
  root: CompactSchema,
  value: unknown,
  options: SchemaValidationOptions = {},
): SchemaValidation {
  const compatibilityIssue = jsonCompatibilityIssue(value);
  if (compatibilityIssue !== undefined) {
    return { ok: false, issues: [compatibilityIssue] };
  }

  const definitions = options.definitions ?? {};
  assertWellFormedSchema(root, definitions);
  const maxDepth = options.maxDepth ?? 64;
  const maxIssues = options.maxIssues ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError("maxDepth must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1) {
    throw new RangeError("maxIssues must be a positive safe integer");
  }

  const issues: SchemaIssue[] = [];
  const add = (issue: SchemaIssue): void => {
    if (issues.length < maxIssues) {
      issues.push(issue);
    }
  };

  const check = (
    current: CompactSchema,
    candidate: JsonValue,
    path: string,
    depth: number,
  ): boolean => {
    if (depth > maxDepth) {
      add({
        path,
        code: "max_depth",
        message: `Value exceeds validation depth ${maxDepth}`,
      });
      return false;
    }
    const issueCountBefore = issues.length;

    switch (current.kind) {
      case "any":
        return true;
      case "null":
        if (candidate !== null) {
          add({ path, code: "type", message: "Expected null" });
        }
        break;
      case "boolean":
        if (typeof candidate !== "boolean") {
          add({ path, code: "type", message: "Expected a boolean" });
        }
        break;
      case "string":
        if (typeof candidate !== "string") {
          add({ path, code: "type", message: "Expected a string" });
          break;
        }
        const scalarLength = unicodeScalarLength(candidate);
        if (
          current.minLength !== undefined &&
          scalarLength < current.minLength
        ) {
          add({
            path,
            code: "min_length",
            message: `Expected at least ${current.minLength} Unicode scalar values`,
          });
        }
        if (
          current.maxLength !== undefined &&
          scalarLength > current.maxLength
        ) {
          add({
            path,
            code: "max_length",
            message: `Expected at most ${current.maxLength} Unicode scalar values`,
          });
        }
        if (
          current.pattern !== undefined &&
          !new RegExp(current.pattern, "u").test(candidate)
        ) {
          add({
            path,
            code: "pattern",
            message: `String does not match /${current.pattern}/u`,
          });
        }
        break;
      case "number":
        if (
          typeof candidate !== "number" ||
          !Number.isFinite(candidate) ||
          (current.integer === true && !Number.isSafeInteger(candidate))
        ) {
          add({
            path,
            code: "type",
            message:
              current.integer === true
                ? "Expected a safe integer"
                : "Expected a finite number",
          });
          break;
        }
        if (
          current.minimum !== undefined &&
          candidate < current.minimum
        ) {
          add({
            path,
            code: "minimum",
            message: `Expected a number >= ${current.minimum}`,
          });
        }
        if (
          current.maximum !== undefined &&
          candidate > current.maximum
        ) {
          add({
            path,
            code: "maximum",
            message: `Expected a number <= ${current.maximum}`,
          });
        }
        break;
      case "literal":
        if (!canonicalEqual(candidate, current.value)) {
          add({
            path,
            code: "literal",
            message: `Expected ${canonicalJson(current.value)}`,
          });
        }
        break;
      case "enum":
        if (
          !current.values.some((allowed) =>
            canonicalEqual(candidate, allowed),
          )
        ) {
          add({
            path,
            code: "enum",
            message: `Expected one of ${canonicalJson(current.values)}`,
          });
        }
        break;
      case "array":
        if (!Array.isArray(candidate)) {
          add({ path, code: "type", message: "Expected an array" });
          break;
        }
        if (
          current.minItems !== undefined &&
          candidate.length < current.minItems
        ) {
          add({
            path,
            code: "min_items",
            message: `Expected at least ${current.minItems} items`,
          });
        }
        if (
          current.maxItems !== undefined &&
          candidate.length > current.maxItems
        ) {
          add({
            path,
            code: "max_items",
            message: `Expected at most ${current.maxItems} items`,
          });
        }
        for (let index = 0; index < candidate.length; index += 1) {
          check(
            current.items,
            candidate[index] as JsonValue,
            valuePath(path, index),
            depth + 1,
          );
        }
        break;
      case "tuple":
        if (!Array.isArray(candidate)) {
          add({ path, code: "type", message: "Expected an array tuple" });
          break;
        }
        if (
          candidate.length < current.items.length ||
          (current.rest === undefined &&
            candidate.length !== current.items.length)
        ) {
          add({
            path,
            code: "tuple_length",
            message:
              current.rest === undefined
                ? `Expected exactly ${current.items.length} items`
                : `Expected at least ${current.items.length} items`,
          });
        }
        for (
          let index = 0;
          index < Math.min(candidate.length, current.items.length);
          index += 1
        ) {
          check(
            current.items[index] as CompactSchema,
            candidate[index] as JsonValue,
            valuePath(path, index),
            depth + 1,
          );
        }
        if (current.rest !== undefined) {
          for (
            let index = current.items.length;
            index < candidate.length;
            index += 1
          ) {
            check(
              current.rest,
              candidate[index] as JsonValue,
              valuePath(path, index),
              depth + 1,
            );
          }
        }
        break;
      case "record": {
        if (!isObject(candidate)) {
          add({ path, code: "type", message: "Expected an object" });
          break;
        }
        const fields = new Map(
          current.fields.map((field) => [field.name, field] as const),
        );
        for (const field of current.fields) {
          if (!Object.hasOwn(candidate, field.name)) {
            if (field.required) {
              add({
                path: valuePath(path, field.name),
                code: "required",
                message: "Required field is missing",
              });
            }
            continue;
          }
          check(
            field.schema,
            candidate[field.name] as JsonValue,
            valuePath(path, field.name),
            depth + 1,
          );
        }
        for (const key of Object.keys(candidate)) {
          if (fields.has(key)) {
            continue;
          }
          if (
            current.additional === undefined ||
            current.additional === false
          ) {
            add({
              path: valuePath(path, key),
              code: "additional",
              message: "Additional fields are not permitted",
            });
          } else if (current.additional !== true) {
            check(
              current.additional,
              candidate[key] as JsonValue,
              valuePath(path, key),
              depth + 1,
            );
          }
        }
        break;
      }
      case "union": {
        const matched = current.variants.some((variant) => {
          const branch = validateSchema(variant, candidate, {
            definitions,
            maxDepth: Math.max(1, maxDepth - depth),
            maxIssues: 1,
          });
          return branch.ok;
        });
        if (!matched) {
          add({
            path,
            code: "union",
            message: "Value does not match any union variant",
          });
        }
        break;
      }
      case "ref": {
        const target = definitions[current.name];
        if (target === undefined) {
          add({
            path,
            code: "unknown_ref",
            message: `Unknown schema reference ${JSON.stringify(current.name)}`,
          });
          break;
        }
        check(target, candidate, path, depth + 1);
        break;
      }
    }

    return issues.length === issueCountBefore;
  };

  check(root, value as JsonValue, "$", 0);
  return issues.length === 0
    ? { ok: true, value: value as JsonValue }
    : { ok: false, issues };
}

export class SchemaValidationError extends TypeError {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super(
      `Schema validation failed: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export function assertMatchesSchema(
  expected: CompactSchema,
  value: unknown,
  options: SchemaValidationOptions = {},
): asserts value is JsonValue {
  const result = validateSchema(expected, value, options);
  if (!result.ok) {
    throw new SchemaValidationError(result.issues);
  }
}

function optionalNumber(value: number | undefined): JsonValue {
  return value ?? null;
}

function trimTrailingNulls(values: JsonValue[]): JsonValue[] {
  while (values.at(-1) === null) {
    values.pop();
  }
  return values;
}

/**
 * Encode a schema into AXF1's token-efficient JSON representation.
 *
 * Scalar schemas are one-character strings. Composite forms are tagged arrays;
 * omitted trailing options cost no model tokens.
 */
export function encodeCompactSchema(input: CompactSchema): JsonValue {
  switch (input.kind) {
    case "any":
      return "*";
    case "null":
      return "0";
    case "boolean":
      return "b";
    case "string":
      if (
        input.minLength === undefined &&
        input.maxLength === undefined &&
        input.pattern === undefined
      ) {
        return "s";
      }
      return trimTrailingNulls([
        "s",
        optionalNumber(input.minLength),
        optionalNumber(input.maxLength),
        input.pattern ?? null,
      ]);
    case "number": {
      const tag = input.integer === true ? "i" : "n";
      if (input.minimum === undefined && input.maximum === undefined) {
        return tag;
      }
      return trimTrailingNulls([
        tag,
        input.minimum ?? null,
        input.maximum ?? null,
      ]);
    }
    case "literal":
      return ["=", input.value];
    case "enum":
      return ["e", ...input.values];
    case "array":
      return trimTrailingNulls([
        "a",
        encodeCompactSchema(input.items),
        optionalNumber(input.minItems),
        optionalNumber(input.maxItems),
      ]);
    case "tuple": {
      const encoded: JsonValue[] = [
        "t",
        input.items.map((item) => encodeCompactSchema(item)),
      ];
      if (input.rest !== undefined) {
        encoded.push(encodeCompactSchema(input.rest));
      }
      return encoded;
    }
    case "record": {
      const fields: JsonValue[] = input.fields.map((field) =>
        field.required
          ? [field.name, encodeCompactSchema(field.schema)]
          : [field.name, encodeCompactSchema(field.schema), 0],
      );
      const encoded: JsonValue[] = ["o", fields];
      if (input.additional !== undefined && input.additional !== false) {
        encoded.push(
          input.additional === true
            ? true
            : encodeCompactSchema(input.additional),
        );
      }
      return encoded;
    }
    case "union":
      return ["u", ...input.variants.map(encodeCompactSchema)];
    case "ref":
      return ["r", input.name];
  }
}

function schemaArray(value: JsonValue, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new SchemaDefinitionError("Expected a schema array", path);
  }
  return value;
}

function nullableNonNegativeInteger(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SchemaDefinitionError(
      "Expected a non-negative safe integer or null",
      path,
    );
  }
  return value as number;
}

function nullableFiniteNumber(
  value: JsonValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaDefinitionError("Expected a finite number or null", path);
  }
  return value;
}

function exactLength(
  values: readonly JsonValue[],
  minimum: number,
  maximum: number,
  path: string,
): void {
  if (values.length < minimum || values.length > maximum) {
    throw new SchemaDefinitionError(
      `Expected ${minimum === maximum ? minimum : `${minimum}-${maximum}`} items`,
      path,
    );
  }
}

export function decodeCompactSchema(
  encoded: JsonValue,
  path = "$schema",
): CompactSchema {
  if (typeof encoded === "string") {
    switch (encoded) {
      case "*":
        return schema.any();
      case "0":
        return schema.null();
      case "b":
        return schema.boolean();
      case "s":
        return schema.string();
      case "n":
        return schema.number();
      case "i":
        return schema.integer();
      default:
        throw new SchemaDefinitionError(
          `Unknown scalar schema tag ${JSON.stringify(encoded)}`,
          path,
        );
    }
  }

  const values = schemaArray(encoded, path);
  const tag = values[0];
  if (typeof tag !== "string") {
    throw new SchemaDefinitionError("Schema tag must be a string", `${path}[0]`);
  }

  let decoded: CompactSchema;
  switch (tag) {
    case "s": {
      exactLength(values, 2, 4, path);
      const minLength = nullableNonNegativeInteger(values[1], `${path}[1]`);
      const maxLength = nullableNonNegativeInteger(values[2], `${path}[2]`);
      const rawPattern = values[3];
      if (
        rawPattern !== undefined &&
        rawPattern !== null &&
        typeof rawPattern !== "string"
      ) {
        throw new SchemaDefinitionError(
          "String pattern must be a string or null",
          `${path}[3]`,
        );
      }
      decoded = {
        kind: "string",
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(typeof rawPattern === "string" ? { pattern: rawPattern } : {}),
      };
      break;
    }
    case "n":
    case "i": {
      exactLength(values, 2, 3, path);
      const minimum = nullableFiniteNumber(values[1], `${path}[1]`);
      const maximum = nullableFiniteNumber(values[2], `${path}[2]`);
      decoded = {
        kind: "number",
        ...(tag === "i" ? { integer: true } : {}),
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
      break;
    }
    case "=":
      exactLength(values, 2, 2, path);
      if (
        values[1] !== null &&
        typeof values[1] !== "boolean" &&
        typeof values[1] !== "number" &&
        typeof values[1] !== "string"
      ) {
        throw new SchemaDefinitionError(
          "Literal schemas require a primitive value",
          `${path}[1]`,
        );
      }
      decoded = schema.literal(values[1]);
      break;
    case "e": {
      if (values.length < 2) {
        throw new SchemaDefinitionError(
          "Enum schemas need at least one value",
          path,
        );
      }
      const enumValues: JsonPrimitive[] = [];
      for (let index = 1; index < values.length; index += 1) {
        const value = values[index] as JsonValue;
        if (
          value !== null &&
          typeof value !== "boolean" &&
          typeof value !== "number" &&
          typeof value !== "string"
        ) {
          throw new SchemaDefinitionError(
            "Enum values must be primitive",
            `${path}[${index}]`,
          );
        }
        enumValues.push(value);
      }
      decoded = schema.enum(enumValues);
      break;
    }
    case "a": {
      exactLength(values, 2, 4, path);
      const minItems = nullableNonNegativeInteger(values[2], `${path}[2]`);
      const maxItems = nullableNonNegativeInteger(values[3], `${path}[3]`);
      decoded = {
        kind: "array",
        items: decodeCompactSchema(values[1] as JsonValue, `${path}[1]`),
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
      };
      break;
    }
    case "t": {
      exactLength(values, 2, 3, path);
      const itemValues = schemaArray(values[1] as JsonValue, `${path}[1]`);
      const items = itemValues.map((item, index) =>
        decodeCompactSchema(item, `${path}[1][${index}]`),
      );
      const rest =
        values[2] === undefined
          ? undefined
          : decodeCompactSchema(values[2], `${path}[2]`);
      decoded =
        rest === undefined
          ? schema.tuple(items)
          : schema.tuple(items, rest);
      break;
    }
    case "o": {
      exactLength(values, 2, 3, path);
      const fieldValues = schemaArray(values[1] as JsonValue, `${path}[1]`);
      const fields = fieldValues.map((fieldValue, index) => {
        const fieldPath = `${path}[1][${index}]`;
        const parts = schemaArray(fieldValue, fieldPath);
        exactLength(parts, 2, 3, fieldPath);
        if (typeof parts[0] !== "string") {
          throw new SchemaDefinitionError(
            "Record field name must be a string",
            `${fieldPath}[0]`,
          );
        }
        if (parts[2] !== undefined && parts[2] !== 0) {
          throw new SchemaDefinitionError(
            "Optional-field marker must be 0",
            `${fieldPath}[2]`,
          );
        }
        return schema.field(
          parts[0],
          decodeCompactSchema(parts[1] as JsonValue, `${fieldPath}[1]`),
          parts[2] !== 0,
        );
      });
      const rawAdditional = values[2];
      let additional: boolean | CompactSchema | undefined;
      if (rawAdditional !== undefined) {
        additional =
          typeof rawAdditional === "boolean"
            ? rawAdditional
            : decodeCompactSchema(rawAdditional, `${path}[2]`);
      }
      decoded = schema.record(fields, additional);
      break;
    }
    case "u":
      if (values.length < 3) {
        throw new SchemaDefinitionError(
          "Union schemas need at least two variants",
          path,
        );
      }
      decoded = schema.union(
        values
          .slice(1)
          .map((variant, index) =>
            decodeCompactSchema(variant, `${path}[${index + 1}]`),
          ),
      );
      break;
    case "r":
      exactLength(values, 2, 2, path);
      if (typeof values[1] !== "string") {
        throw new SchemaDefinitionError(
          "Reference name must be a string",
          `${path}[1]`,
        );
      }
      decoded = schema.ref(values[1]);
      break;
    default:
      throw new SchemaDefinitionError(
        `Unknown composite schema tag ${JSON.stringify(tag)}`,
        `${path}[0]`,
      );
  }

  // Reference resolution and whole-tree validation happen once the caller has
  // decoded the optional definitions environment.
  return decoded;
}

export function toJsonSchema(input: CompactSchema): JsonObject {
  switch (input.kind) {
    case "any":
      return {};
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean" };
    case "string":
      return {
        type: "string",
        ...(input.minLength === undefined
          ? {}
          : { minLength: input.minLength }),
        ...(input.maxLength === undefined
          ? {}
          : { maxLength: input.maxLength }),
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
      };
    case "number":
      return {
        type: input.integer === true ? "integer" : "number",
        ...(input.minimum === undefined ? {} : { minimum: input.minimum }),
        ...(input.maximum === undefined ? {} : { maximum: input.maximum }),
      };
    case "literal":
      return { const: input.value };
    case "enum":
      return { enum: input.values };
    case "array":
      return {
        type: "array",
        items: toJsonSchema(input.items),
        ...(input.minItems === undefined ? {} : { minItems: input.minItems }),
        ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
      };
    case "tuple":
      return {
        type: "array",
        prefixItems: input.items.map(toJsonSchema),
        minItems: input.items.length,
        ...(input.rest === undefined
          ? { maxItems: input.items.length, items: false }
          : { items: toJsonSchema(input.rest) }),
      };
    case "record": {
      const properties = Object.create(null) as Record<string, JsonValue>;
      const required: JsonValue[] = [];
      for (const field of input.fields) {
        properties[field.name] = toJsonSchema(field.schema);
        if (field.required) {
          required.push(field.name);
        }
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties:
          input.additional === undefined || input.additional === false
            ? false
            : input.additional === true
              ? true
              : toJsonSchema(input.additional),
      };
    }
    case "union":
      return { anyOf: input.variants.map(toJsonSchema) };
    case "ref":
      return {
        $ref: `#/$defs/${input.name
          .replace(/~/gu, "~0")
          .replace(/\//gu, "~1")}`,
      };
  }
}

export function jsonSchemaDocument(
  root: CompactSchema,
  definitions: SchemaDefinitions = {},
): JsonObject {
  assertWellFormedSchema(root, definitions);
  const encodedDefinitions = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const name of Object.keys(definitions).sort()) {
    encodedDefinitions[name] = toJsonSchema(
      definitions[name] as CompactSchema,
    );
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...toJsonSchema(root),
    ...(Object.keys(encodedDefinitions).length === 0
      ? {}
      : { $defs: encodedDefinitions }),
  };
}

export interface ScalarTypeDescriptor {
  readonly kind:
    | "any"
    | "null"
    | "boolean"
    | "string"
    | "number"
    | "integer";
}

export interface LiteralTypeDescriptor {
  readonly kind: "literal";
  readonly value: JsonPrimitive;
}

export interface ArrayTypeDescriptor {
  readonly kind: "array";
  readonly element: SchemaTypeDescriptor;
}

export interface TupleTypeDescriptor {
  readonly kind: "tuple";
  readonly elements: readonly SchemaTypeDescriptor[];
}

export interface UnionTypeDescriptor {
  readonly kind: "union";
  readonly variants: readonly SchemaTypeDescriptor[];
}

export interface OptionalTypeDescriptor {
  readonly kind: "optional";
  readonly value: SchemaTypeDescriptor;
}

export interface ReferenceTypeDescriptor {
  readonly kind: "ref";
  readonly name: string;
}

export interface RecordTypeFieldDescriptor {
  readonly name: string;
  readonly type: SchemaTypeDescriptor;
  readonly optional?: boolean;
}

export interface RecordTypeDescriptor {
  readonly kind: "record";
  readonly fields: readonly RecordTypeFieldDescriptor[];
  readonly open?: boolean;
}

/**
 * Structural type accepted by the compiler-to-protocol bridge. Parser/compiler
 * ASTs can implement this shape without schema.ts importing or depending on
 * their concrete node classes.
 */
export type SchemaTypeDescriptor =
  | ScalarTypeDescriptor
  | LiteralTypeDescriptor
  | ArrayTypeDescriptor
  | TupleTypeDescriptor
  | UnionTypeDescriptor
  | OptionalTypeDescriptor
  | ReferenceTypeDescriptor
  | RecordTypeDescriptor;

export function schemaFromTypeDescriptor(
  descriptor: SchemaTypeDescriptor,
): CompactSchema {
  switch (descriptor.kind) {
    case "any":
      return schema.any();
    case "null":
      return schema.null();
    case "boolean":
      return schema.boolean();
    case "string":
      return schema.string();
    case "number":
      return schema.number();
    case "integer":
      return schema.integer();
    case "literal":
      return schema.literal(descriptor.value);
    case "array":
      return schema.array(schemaFromTypeDescriptor(descriptor.element));
    case "tuple":
      return schema.tuple(
        descriptor.elements.map(schemaFromTypeDescriptor),
      );
    case "union":
      return schema.union(
        descriptor.variants.map(schemaFromTypeDescriptor),
      );
    case "optional":
      // Missingness is represented on record fields. At a standalone value
      // boundary, optional means the value or JSON null.
      return schema.union([
        schemaFromTypeDescriptor(descriptor.value),
        schema.null(),
      ]);
    case "ref":
      return schema.ref(descriptor.name);
    case "record":
      return recordSchemaFromDescriptor(descriptor);
  }
}

export function recordSchemaFromDescriptor(
  descriptor: RecordTypeDescriptor,
): RecordSchema {
  return schema.record(
    descriptor.fields.map((field) => {
      const wrappedOptional = field.type.kind === "optional";
      const fieldType = wrappedOptional ? field.type.value : field.type;
      return schema.field(
        field.name,
        schemaFromTypeDescriptor(fieldType),
        field.optional !== true && !wrappedOptional,
      );
    }),
    descriptor.open === true,
  );
}
