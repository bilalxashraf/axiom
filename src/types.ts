import type { AirRecord, AirType, JsonValue } from "./ir.ts";
import {
  assertMatchesSchema,
  CANONICAL_BASE64_PATTERN,
  schema,
  type CompactSchema,
  type SchemaDefinitions,
  SchemaValidationError,
} from "./schema.ts";

export function typeToString(type: AirType): string {
  switch (type.kind) {
    case "named":
      return type.name;
    case "list":
      return `List<${typeToString(type.element)}>`;
    case "candidate":
      return `Candidate<${typeToString(type.value)}>`;
    case "evidence":
      return `Evidence<${type.proposition}>`;
  }
}

export function typeEquals(left: AirType, right: AirType): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "named":
      return right.kind === "named" && left.name === right.name;
    case "list":
      return right.kind === "list" && typeEquals(left.element, right.element);
    case "candidate":
      return right.kind === "candidate" && typeEquals(left.value, right.value);
    case "evidence":
      return right.kind === "evidence" && left.proposition === right.proposition;
  }
}

export function unwrapCandidate(type: AirType): AirType | undefined {
  return type.kind === "candidate" ? type.value : undefined;
}

export function airTypeToSchema(type: AirType): CompactSchema {
  switch (type.kind) {
    case "list":
      return schema.array(airTypeToSchema(type.element));
    case "candidate":
      return airTypeToSchema(type.value);
    case "evidence":
      return schema.record([
        schema.field("proposition", schema.literal(type.proposition)),
        schema.field("evidence_id", schema.string()),
      ]);
    case "named":
      switch (type.name) {
        case "Text":
          return schema.string();
        case "Bytes":
          return schema.string({ pattern: CANONICAL_BASE64_PATTERN });
        case "Int":
          return schema.integer();
        case "Bool":
          return schema.boolean();
        case "Unit":
          return schema.null();
        case "Json":
          return schema.any();
        default:
          return schema.ref(type.name);
      }
  }
}

export function recordDefinitions(records: readonly AirRecord[]): SchemaDefinitions {
  const definitions = Object.create(null) as Record<string, CompactSchema>;
  for (const record of records) {
    definitions[record.name] = schema.record(
      record.fields.map((field) =>
        schema.field(field.name, airTypeToSchema(field.type)),
      ),
    );
  }
  return definitions;
}

/**
 * Build only the schema definitions reachable from the types in one inference
 * frame. Unrelated program records therefore consume zero model tokens.
 */
export function recordDefinitionsFor(
  records: readonly AirRecord[],
  roots: readonly AirType[],
): SchemaDefinitions {
  const byName = new Map(records.map((record) => [record.name, record]));
  const reachable = new Set<string>();

  const visit = (type: AirType): void => {
    switch (type.kind) {
      case "list":
        visit(type.element);
        return;
      case "candidate":
        visit(type.value);
        return;
      case "evidence":
        return;
      case "named": {
        const record = byName.get(type.name);
        if (record === undefined || reachable.has(type.name)) {
          return;
        }
        reachable.add(type.name);
        for (const field of record.fields) {
          visit(field.type);
        }
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }
  return recordDefinitions(
    records.filter((record) => reachable.has(record.name)),
  );
}

export function assertValueMatchesType(
  value: JsonValue,
  type: AirType,
  records: readonly AirRecord[],
): void {
  assertMatchesSchema(airTypeToSchema(type), value, {
    definitions: recordDefinitions(records),
  });
  assertCanonicalBytes(value, type, new Map(records.map((record) => [
    record.name,
    record,
  ])));
}

function assertCanonicalBytes(
  value: JsonValue,
  type: AirType,
  records: ReadonlyMap<string, AirRecord>,
  path = "$",
): void {
  switch (type.kind) {
    case "candidate":
      assertCanonicalBytes(value, type.value, records, path);
      return;
    case "evidence":
      return;
    case "list":
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          assertCanonicalBytes(item, type.element, records, `${path}[${index}]`);
        });
      }
      return;
    case "named":
      if (type.name === "Bytes" && typeof value === "string") {
        if (Buffer.from(value, "base64").toString("base64") !== value) {
          throw new SchemaValidationError([
            {
              path,
              code: "pattern",
              message: "Expected canonical RFC 4648 base64",
            },
          ]);
        }
        return;
      }
      {
        const record = records.get(type.name);
        if (
          record !== undefined &&
          value !== null &&
          !Array.isArray(value) &&
          typeof value === "object"
        ) {
          const object = value as Readonly<Record<string, JsonValue>>;
          for (const field of record.fields) {
            assertCanonicalBytes(
              object[field.name] as JsonValue,
              field.type,
              records,
              `${path}.${field.name}`,
            );
          }
        }
      }
  }
}
