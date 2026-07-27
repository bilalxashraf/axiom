import {
  canonicalHash,
  canonicalJson,
  parseJson,
  sha256Text,
  unicodeScalarLength,
  utf8ByteLength,
  type JsonObject,
  type JsonValue,
  type Sha256,
} from "./canonical.ts";
import {
  assertMatchesSchema,
  assertWellFormedSchema,
  decodeCompactSchema,
  encodeCompactSchema,
  type CompactSchema,
  type SchemaDefinitions,
} from "./schema.ts";
import { MAX_AXIP_TEXT_SCALARS } from "./limits.ts";

export const AXIP_VERSION = "AXIP/1" as const;
export const AXIP_PROLOGUE_MAGIC = "AXP1" as const;
export const AXIP_FRAME_MAGIC = "AXF1" as const;
export const AXIP_OUTPUT_MAGIC = "AXO1" as const;

/**
 * The only natural-language bootstrap needed by AXIP/1. It is stable and can
 * be prefix-cached or replaced by its content hash after a model/session has
 * installed it.
 */
export const AXIP_INLINE_PROLOGUE = [
  AXIP_PROLOGUE_MAGIC,
  "Act as a typed inference function. Read the AXF1 JSON frame.",
  "Keys: r=run, p=program, n=node, o=operation, i=input schema, u=output schema, x=inputs, g=active obligations, a=allowed outputs(c/n/f), b=limits[input bytes/output bytes/tokens/attempts], c=context refs, d=definitions, h=prologue ref.",
  'Schema: "*"=any, "0"=null, "b"=boolean, "s"=string, "n"=number, "i"=integer. Tagged arrays: ["s",min?,max?,pattern?], ["n"|"i",min?,max?], ["=",literal], ["e",...values], ["a",item,min?,max?], ["t",items,rest?], ["o",[[name,schema,optional-0?]],additional?], ["u",...variants], ["r",name]. null placeholders mean omitted.',
  'Reply with only AXO1 then JSON. Echo r and n. k="c": include v matching u; k="n": include q, refs from c; k="f": include e={c:code,m:message,r:retryable,d?:details}.',
  "Use only a response kind listed in a. Do not add keys, prose, or markdown.",
].join("\n");

export const AXIP_PROLOGUE_HASH: Sha256 = sha256Text(AXIP_INLINE_PROLOGUE);

export type AxipResponseKind = "candidate" | "need_context" | "fail";

export interface AxipBudget {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxTokens: number;
  readonly maxAttempts: number;
}

export interface AxipRequest {
  readonly protocol: typeof AXIP_VERSION;
  readonly runId: string;
  readonly programHash: Sha256;
  readonly nodeId: string;
  readonly operation: string;
  readonly inputSchema: CompactSchema;
  readonly outputSchema: CompactSchema;
  readonly schemaDefinitions?: SchemaDefinitions;
  readonly inputs: JsonValue;
  readonly activeObligations: readonly string[];
  readonly allowedResponses: readonly AxipResponseKind[];
  readonly budget: AxipBudget;
  readonly contextRefs: readonly string[];
  /**
   * Hash or registry identifier for an already installed semantic prologue.
   * Set this when EncodeAxipOptions.prologue is "reference".
   */
  readonly prologueRef?: string;
}

export type AxipRequestInput = Omit<AxipRequest, "protocol"> & {
  readonly protocol?: typeof AXIP_VERSION;
};

export interface AxipCandidateResponse {
  readonly protocol: typeof AXIP_VERSION;
  readonly kind: "candidate";
  readonly runId: string;
  readonly nodeId: string;
  readonly value: JsonValue;
}

export interface AxipNeedContextResponse {
  readonly protocol: typeof AXIP_VERSION;
  readonly kind: "need_context";
  readonly runId: string;
  readonly nodeId: string;
  readonly refs: readonly string[];
}

export interface AxipFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export interface AxipFailResponse {
  readonly protocol: typeof AXIP_VERSION;
  readonly kind: "fail";
  readonly runId: string;
  readonly nodeId: string;
  readonly error: AxipFailure;
}

export type AxipResponse =
  | AxipCandidateResponse
  | AxipNeedContextResponse
  | AxipFailResponse;

export interface EncodeAxipOptions {
  /**
   * "inline" is portable to an arbitrary text model. "reference" saves prompt
   * tokens but requires the adapter/model session to have installed prologueRef.
   */
  readonly prologue?: "inline" | "reference";
}

export interface ParseAxoOptions {
  /**
   * Canonical output is useful for machine-produced fixtures. It is off by
   * default because key ordering is not a semantic burden models should carry.
   */
  readonly requireCanonicalJson?: boolean;
}

export class AxipProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AxipProtocolError";
    this.code = code;
  }
}

const RESPONSE_KIND_TO_CODE = {
  candidate: "c",
  need_context: "n",
  fail: "f",
} as const satisfies Record<AxipResponseKind, string>;

const RESPONSE_CODE_TO_KIND = {
  c: "candidate",
  n: "need_context",
  f: "fail",
} as const;

type AxipResponseCode = keyof typeof RESPONSE_CODE_TO_KIND;

function protocolError(code: string, message: string): never {
  throw new AxipProtocolError(code, message);
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  maximumLength = MAX_AXIP_TEXT_SCALARS,
): asserts value is string {
  if (typeof value !== "string") {
    protocolError(
      "AXIP_INVALID_FIELD",
      `${label} must be a Unicode scalar string`,
    );
  }
  let length: number;
  try {
    length = unicodeScalarLength(value);
  } catch {
    protocolError(
      "AXIP_INVALID_FIELD",
      `${label} must contain only Unicode scalar values`,
    );
  }
  if (length === 0 || length > maximumLength) {
    protocolError(
      "AXIP_INVALID_FIELD",
      `${label} must contain 1-${maximumLength} Unicode scalar values`,
    );
  }
}

function requirePositiveSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    protocolError(
      "AXIP_INVALID_BUDGET",
      `${label} must be a positive safe integer`,
    );
  }
}

function requireUniqueStrings(
  values: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireNonEmptyString(value, label);
    if (seen.has(value)) {
      protocolError(
        "AXIP_DUPLICATE_FIELD",
        `${label} contains duplicate ${JSON.stringify(value)}`,
      );
    }
    seen.add(value);
  }
}

function isSha256(value: string): value is Sha256 {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function validateAxipRequest(input: AxipRequest): void {
  if (input.protocol !== AXIP_VERSION) {
    protocolError(
      "AXIP_VERSION",
      `Expected protocol ${AXIP_VERSION}, received ${JSON.stringify(input.protocol)}`,
    );
  }
  requireNonEmptyString(input.runId, "runId");
  requireNonEmptyString(input.nodeId, "nodeId");
  requireNonEmptyString(input.operation, "operation");
  if (!isSha256(input.programHash)) {
    protocolError(
      "AXIP_PROGRAM_HASH",
      "programHash must be a lowercase sha256:<64 hex digits> digest",
    );
  }

  const definitions = input.schemaDefinitions ?? {};
  assertWellFormedSchema(input.inputSchema, definitions);
  assertWellFormedSchema(input.outputSchema, definitions);
  try {
    assertMatchesSchema(input.inputSchema, input.inputs, { definitions });
  } catch (error) {
    protocolError(
      "AXIP_INPUT_SCHEMA",
      error instanceof Error ? error.message : String(error),
    );
  }

  requireUniqueStrings(input.activeObligations, "activeObligations");
  requireUniqueStrings(input.contextRefs, "contextRefs");
  if (input.allowedResponses.length === 0) {
    protocolError(
      "AXIP_ALLOWED_RESPONSES",
      "allowedResponses cannot be empty",
    );
  }
  const responseKinds = new Set<AxipResponseKind>();
  for (const kind of input.allowedResponses) {
    if (!Object.hasOwn(RESPONSE_KIND_TO_CODE, kind)) {
      protocolError(
        "AXIP_ALLOWED_RESPONSES",
        `Unknown response kind ${JSON.stringify(kind)}`,
      );
    }
    if (responseKinds.has(kind)) {
      protocolError(
        "AXIP_ALLOWED_RESPONSES",
        `Duplicate response kind ${JSON.stringify(kind)}`,
      );
    }
    responseKinds.add(kind);
  }

  requirePositiveSafeInteger(input.budget.maxInputBytes, "maxInputBytes");
  requirePositiveSafeInteger(input.budget.maxOutputBytes, "maxOutputBytes");
  requirePositiveSafeInteger(input.budget.maxTokens, "maxTokens");
  requirePositiveSafeInteger(input.budget.maxAttempts, "maxAttempts");
  if (
    input.prologueRef !== undefined &&
    input.prologueRef !== AXIP_PROLOGUE_HASH
  ) {
    protocolError(
      "AXIP_PROLOGUE_REF",
      `AXIP/1 prologueRef must equal the fixed semantic prologue hash ${AXIP_PROLOGUE_HASH}`,
    );
  }
}

export function createAxipRequest(input: AxipRequestInput): AxipRequest {
  const request: AxipRequest = {
    ...input,
    protocol: AXIP_VERSION,
  };
  validateAxipRequest(request);
  return request;
}

function encodeDefinitions(
  definitions: SchemaDefinitions,
): JsonObject {
  const encoded = Object.create(null) as Record<string, JsonValue>;
  for (const name of Object.keys(definitions).sort()) {
    encoded[name] = encodeCompactSchema(
      definitions[name] as CompactSchema,
    );
  }
  return encoded;
}

/**
 * Convert a readable request to AXF1's stable, compact key space.
 *
 * r=run, p=program, n=node, o=operation, i=input schema, u=output schema,
 * x=inputs, g=live goals, a=allowed outputs, b=budgets, c=context, d=defs,
 * h=semantic prologue reference.
 */
export function axipRequestPayload(request: AxipRequest): JsonObject {
  validateAxipRequest(request);
  return {
    r: request.runId,
    p: request.programHash,
    n: request.nodeId,
    o: request.operation,
    i: encodeCompactSchema(request.inputSchema),
    u: encodeCompactSchema(request.outputSchema),
    x: request.inputs,
    g: request.activeObligations,
    a: request.allowedResponses.map(
      (kind) => RESPONSE_KIND_TO_CODE[kind],
    ),
    b: [
      request.budget.maxInputBytes,
      request.budget.maxOutputBytes,
      request.budget.maxTokens,
      request.budget.maxAttempts,
    ],
    c: request.contextRefs,
    ...(request.schemaDefinitions === undefined ||
    Object.keys(request.schemaDefinitions).length === 0
      ? {}
      : { d: encodeDefinitions(request.schemaDefinitions) }),
    ...(request.prologueRef === undefined
      ? {}
      : { h: request.prologueRef }),
  };
}

export function encodeAxipRequest(
  request: AxipRequest,
  options: EncodeAxipOptions = {},
): string {
  const payload = canonicalJson(axipRequestPayload(request));
  const mode = options.prologue ?? "inline";
  let prologue: string;
  if (mode === "reference") {
    if (request.prologueRef === undefined) {
      protocolError(
        "AXIP_PROLOGUE_REF",
        'prologueRef is required when prologue mode is "reference"',
      );
    }
    prologue = `${AXIP_PROLOGUE_MAGIC} @${request.prologueRef}`;
  } else {
    prologue = AXIP_INLINE_PROLOGUE;
  }
  const frame = `${prologue}\n${AXIP_FRAME_MAGIC}\n${payload}`;
  if (utf8ByteLength(frame) > request.budget.maxInputBytes) {
    protocolError(
      "AXIP_INPUT_BUDGET",
      `Encoded request exceeds maxInputBytes (${utf8ByteLength(frame)} > ${request.budget.maxInputBytes})`,
    );
  }
  return frame;
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    protocolError("AXIP_SHAPE", `${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function asArray(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    protocolError("AXIP_SHAPE", `${label} must be a JSON array`);
  }
  return value;
}

function asString(value: JsonValue | undefined, label: string): string {
  requireNonEmptyString(value, label);
  return value;
}

function asSafeInteger(value: JsonValue | undefined, label: string): number {
  requirePositiveSafeInteger(value, label);
  return value as number;
}

function exactKeys(
  object: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "object",
): void {
  const actual = Object.keys(object);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  const extra = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    protocolError(
      "AXIP_KEYS",
      `${label} has invalid keys (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`,
    );
  }
}

function stringArray(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  const values = asArray(value, label);
  const result = values.map((item, index) =>
    asString(item, `${label}[${index}]`),
  );
  requireUniqueStrings(result, label);
  return result;
}

function decodeDefinitions(value: JsonValue | undefined): SchemaDefinitions {
  if (value === undefined) {
    return {};
  }
  const object = asObject(value, "d");
  const definitions = Object.create(null) as Record<
    string,
    CompactSchema
  >;
  for (const name of Object.keys(object)) {
    requireNonEmptyString(name, "definition name");
    definitions[name] = decodeCompactSchema(
      object[name] as JsonValue,
      `d[${JSON.stringify(name)}]`,
    );
  }
  return definitions;
}

function splitAxipFrame(frame: string): {
  readonly prologueRef?: string;
  readonly payloadText: string;
} {
  const marker = `\n${AXIP_FRAME_MAGIC}\n`;
  const markerIndex = frame.indexOf(marker);
  if (markerIndex < 0) {
    protocolError(
      "AXIP_FRAME",
      `Request must contain ${AXIP_FRAME_MAGIC} on its own line`,
    );
  }
  const preamble = frame.slice(0, markerIndex);
  const payloadText = frame.slice(markerIndex + marker.length);
  if (preamble === AXIP_INLINE_PROLOGUE) {
    return { payloadText };
  }
  const referencePrefix = `${AXIP_PROLOGUE_MAGIC} @`;
  if (preamble.startsWith(referencePrefix)) {
    const prologueRef = preamble.slice(referencePrefix.length);
    if (prologueRef !== AXIP_PROLOGUE_HASH) {
      protocolError(
        "AXIP_PROLOGUE_REF",
        `Referenced AXIP/1 prologue must equal ${AXIP_PROLOGUE_HASH}`,
      );
    }
    return { prologueRef, payloadText };
  }
  protocolError(
    "AXIP_PROLOGUE",
    `Request must begin with the AXIP/1 ${AXIP_PROLOGUE_MAGIC} prologue`,
  );
}

export function decodeAxipRequest(frame: string): AxipRequest {
  const split = splitAxipFrame(frame);
  let decoded: JsonValue;
  try {
    decoded = parseJson(split.payloadText);
  } catch (error) {
    protocolError(
      "AXIP_JSON",
      error instanceof Error ? error.message : String(error),
    );
  }
  const payload = asObject(decoded, "AXF1 payload");
  exactKeys(
    payload,
    ["r", "p", "n", "o", "i", "u", "x", "g", "a", "b", "c"],
    ["d", "h"],
    "AXF1 payload",
  );

  const runId = asString(payload.r, "r");
  const programHash = asString(payload.p, "p");
  if (!isSha256(programHash)) {
    protocolError("AXIP_PROGRAM_HASH", "p is not a valid sha256 digest");
  }
  const nodeId = asString(payload.n, "n");
  const operation = asString(payload.o, "o");
  const definitions = decodeDefinitions(payload.d);
  const inputSchema = decodeCompactSchema(payload.i as JsonValue, "i");
  const outputSchema = decodeCompactSchema(payload.u as JsonValue, "u");
  const activeObligations = stringArray(payload.g, "g");
  const contextRefs = stringArray(payload.c, "c");
  const allowedCodes = asArray(payload.a, "a");
  const allowedResponses: AxipResponseKind[] = allowedCodes.map(
    (value, index) => {
      const code = asString(value, `a[${index}]`);
      if (!Object.hasOwn(RESPONSE_CODE_TO_KIND, code)) {
        protocolError(
          "AXIP_ALLOWED_RESPONSES",
          `Unknown response code ${JSON.stringify(code)}`,
        );
      }
      return RESPONSE_CODE_TO_KIND[code as AxipResponseCode];
    },
  );
  const budgetValues = asArray(payload.b, "b");
  if (budgetValues.length !== 4) {
    protocolError("AXIP_INVALID_BUDGET", "b must contain exactly four limits");
  }
  const budget: AxipBudget = {
    maxInputBytes: asSafeInteger(budgetValues[0], "b[0]"),
    maxOutputBytes: asSafeInteger(budgetValues[1], "b[1]"),
    maxTokens: asSafeInteger(budgetValues[2], "b[2]"),
    maxAttempts: asSafeInteger(budgetValues[3], "b[3]"),
  };
  const payloadPrologueRef =
    payload.h === undefined ? undefined : asString(payload.h, "h");
  if (
    split.prologueRef !== undefined &&
    payloadPrologueRef !== split.prologueRef
  ) {
    protocolError(
      "AXIP_PROLOGUE_REF",
      "AXP1 and AXF1 prologue references do not match",
    );
  }
  const prologueRef = split.prologueRef ?? payloadPrologueRef;

  const request: AxipRequest = {
    protocol: AXIP_VERSION,
    runId,
    programHash,
    nodeId,
    operation,
    inputSchema,
    outputSchema,
    ...(Object.keys(definitions).length === 0
      ? {}
      : { schemaDefinitions: definitions }),
    inputs: payload.x as JsonValue,
    activeObligations,
    allowedResponses,
    budget,
    contextRefs,
    ...(prologueRef === undefined ? {} : { prologueRef }),
  };
  validateAxipRequest(request);
  if (utf8ByteLength(frame) > request.budget.maxInputBytes) {
    protocolError(
      "AXIP_INPUT_BUDGET",
      "Received frame exceeds its declared maxInputBytes",
    );
  }
  return request;
}

function candidateWire(response: AxipCandidateResponse): JsonObject {
  return {
    k: RESPONSE_KIND_TO_CODE.candidate,
    r: response.runId,
    n: response.nodeId,
    v: response.value,
  };
}

function contextWire(response: AxipNeedContextResponse): JsonObject {
  return {
    k: RESPONSE_KIND_TO_CODE.need_context,
    r: response.runId,
    n: response.nodeId,
    q: response.refs,
  };
}

function failureWire(error: AxipFailure): JsonObject {
  return {
    c: error.code,
    m: error.message,
    r: error.retryable,
    ...(error.details === undefined ? {} : { d: error.details }),
  };
}

function failWire(response: AxipFailResponse): JsonObject {
  return {
    k: RESPONSE_KIND_TO_CODE.fail,
    r: response.runId,
    n: response.nodeId,
    e: failureWire(response.error),
  };
}

export function axoResponsePayload(response: AxipResponse): JsonObject {
  if (response.protocol !== AXIP_VERSION) {
    protocolError("AXIP_VERSION", "Cannot encode a response for another protocol");
  }
  requireNonEmptyString(response.runId, "runId");
  requireNonEmptyString(response.nodeId, "nodeId");
  switch (response.kind) {
    case "candidate":
      canonicalJson(response.value);
      return candidateWire(response);
    case "need_context":
      requireUniqueStrings(response.refs, "refs");
      if (response.refs.length === 0) {
        protocolError("AXIP_CONTEXT", "need_context refs cannot be empty");
      }
      return contextWire(response);
    case "fail":
      requireNonEmptyString(response.error.code, "error.code");
      requireNonEmptyString(response.error.message, "error.message", 16_384);
      if (typeof response.error.retryable !== "boolean") {
        protocolError("AXIP_FAILURE", "error.retryable must be a boolean");
      }
      if (response.error.details !== undefined) {
        canonicalJson(response.error.details);
      }
      return failWire(response);
  }
}

export function encodeAxoResponse(response: AxipResponse): string {
  return `${AXIP_OUTPUT_MAGIC}\n${canonicalJson(
    axoResponsePayload(response),
  )}`;
}

function parseFailure(value: JsonValue | undefined): AxipFailure {
  const object = asObject(value as JsonValue, "e");
  exactKeys(object, ["c", "m", "r"], ["d"], "e");
  const code = asString(object.c, "e.c");
  const message = asString(object.m, "e.m");
  if (typeof object.r !== "boolean") {
    protocolError("AXIP_FAILURE", "e.r must be a boolean");
  }
  return {
    code,
    message,
    retryable: object.r,
    ...(object.d === undefined ? {} : { details: object.d }),
  };
}

function assertExpectedResponse(
  response: AxipResponse,
  request: AxipRequest,
): void {
  if (response.runId !== request.runId) {
    protocolError(
      "AXIP_RUN_MISMATCH",
      `Expected run ${JSON.stringify(request.runId)}, received ${JSON.stringify(response.runId)}`,
    );
  }
  if (response.nodeId !== request.nodeId) {
    protocolError(
      "AXIP_NODE_MISMATCH",
      `Expected node ${JSON.stringify(request.nodeId)}, received ${JSON.stringify(response.nodeId)}`,
    );
  }
  if (!request.allowedResponses.includes(response.kind)) {
    protocolError(
      "AXIP_RESPONSE_NOT_ALLOWED",
      `${response.kind} is not allowed at this inference node`,
    );
  }
  if (response.kind === "candidate") {
    try {
      assertMatchesSchema(request.outputSchema, response.value, {
        definitions: request.schemaDefinitions ?? {},
      });
    } catch (error) {
      protocolError(
        "AXIP_OUTPUT_SCHEMA",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (response.kind === "need_context") {
    const available = new Set(request.contextRefs);
    const unknown = response.refs.filter((reference) => !available.has(reference));
    if (unknown.length > 0) {
      protocolError(
        "AXIP_CONTEXT",
        `Requested unknown context refs: ${unknown.join(", ")}`,
      );
    }
  }
}

/**
 * Parse a model response with no Markdown extraction or "helpful" repair.
 * Exactly one optional final LF is accepted; all other wrapper text fails.
 */
export function parseAxoResponse(
  frame: string,
  request: AxipRequest,
  options: ParseAxoOptions = {},
): AxipResponse {
  validateAxipRequest(request);
  if (utf8ByteLength(frame) > request.budget.maxOutputBytes) {
    protocolError(
      "AXIP_OUTPUT_BUDGET",
      `Response exceeds maxOutputBytes (${utf8ByteLength(frame)} > ${request.budget.maxOutputBytes})`,
    );
  }
  const withoutFinalLf = frame.endsWith("\n") ? frame.slice(0, -1) : frame;
  const prefix = `${AXIP_OUTPUT_MAGIC}\n`;
  if (!withoutFinalLf.startsWith(prefix)) {
    protocolError(
      "AXIP_OUTPUT_PREFIX",
      `Response must begin with ${AXIP_OUTPUT_MAGIC} followed by LF`,
    );
  }
  const payloadText = withoutFinalLf.slice(prefix.length);
  if (payloadText.length === 0) {
    protocolError("AXIP_OUTPUT_JSON", "Response JSON is missing");
  }
  if (payloadText.trim() !== payloadText) {
    protocolError(
      "AXIP_OUTPUT_JSON",
      "Response JSON cannot have leading or trailing whitespace",
    );
  }

  let decoded: JsonValue;
  try {
    decoded = parseJson(payloadText, {
      requireCanonical: options.requireCanonicalJson === true,
    });
  } catch (error) {
    protocolError(
      "AXIP_OUTPUT_JSON",
      error instanceof Error ? error.message : String(error),
    );
  }
  const payload = asObject(decoded, "AXO1 payload");
  const codeValue = payload.k;
  if (
    typeof codeValue !== "string" ||
    !Object.hasOwn(RESPONSE_CODE_TO_KIND, codeValue)
  ) {
    protocolError(
      "AXIP_OUTPUT_KIND",
      "AXO1 k must be one of c, n, or f",
    );
  }
  const code = codeValue as AxipResponseCode;
  const runId = asString(payload.r, "r");
  const nodeId = asString(payload.n, "n");

  let response: AxipResponse;
  switch (code) {
    case "c":
      exactKeys(payload, ["k", "r", "n", "v"], [], "candidate response");
      response = {
        protocol: AXIP_VERSION,
        kind: "candidate",
        runId,
        nodeId,
        value: payload.v as JsonValue,
      };
      break;
    case "n":
      exactKeys(payload, ["k", "r", "n", "q"], [], "context response");
      response = {
        protocol: AXIP_VERSION,
        kind: "need_context",
        runId,
        nodeId,
        refs: stringArray(payload.q, "q"),
      };
      if (response.refs.length === 0) {
        protocolError("AXIP_CONTEXT", "q cannot be empty");
      }
      break;
    case "f":
      exactKeys(payload, ["k", "r", "n", "e"], [], "failure response");
      response = {
        protocol: AXIP_VERSION,
        kind: "fail",
        runId,
        nodeId,
        error: parseFailure(payload.e),
      };
      break;
  }
  assertExpectedResponse(response, request);
  return response;
}

/**
 * Hash of the semantic compact payload, independent of inline vs referenced
 * prologue transport. This is the stable key used by fixture/replay adapters.
 */
export function axipRequestHash(request: AxipRequest): Sha256 {
  return canonicalHash(axipRequestPayload(request));
}
