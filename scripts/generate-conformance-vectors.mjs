import {
  AXIP_PROLOGUE_HASH,
  axipRequestPayload,
  canonicalHash,
  canonicalJson,
  compileSource,
  createAxipRequest,
  createProgramLock,
  encodeAxoResponse,
  encodeAxipRequest,
  runTask,
  schema,
  sha256Text,
  utf8ByteLength,
} from "../dist/src/index.js";

const source = [
  "axiom 0.1;",
  "",
  "record Result {",
  "  text: Text;",
  "  scalars: Int;",
  "  bytes: Int;",
  "}",
  "",
  "task Main(value: Text) -> Result",
  "must {}",
  "{",
  "  complete Result {",
  "    text: value,",
  "    scalars: len(value),",
  "    bytes: utf8_bytes(value),",
  "  };",
  "}",
  "",
].join("\n");

const compiled = compileSource(source, "core-001.ax");
const input = { value: "😀e\u0301" };
const execution = await runTask(compiled, {
  task: "Main",
  input,
  runId: "golden-run-001",
});
if (execution.status !== "success") {
  throw new Error(`Golden execution failed: ${execution.error.message}`);
}

const request = createAxipRequest({
  runId: "golden-run-001",
  programHash: compiled.hash,
  nodeId: "Main:0:planner",
  operation: "Return the input text and its Unicode scalar count.",
  inputSchema: schema.record([
    schema.field("text", schema.string({ minLength: 1, maxLength: 16 })),
  ]),
  outputSchema: schema.record([
    schema.field("text", schema.string({ minLength: 1, maxLength: 16 })),
    schema.field("scalars", schema.integer({ minimum: 1, maximum: 16 })),
  ]),
  inputs: { text: "😀e\u0301" },
  activeObligations: ["typed-answer"],
  allowedResponses: ["candidate", "need_context", "fail"],
  budget: {
    maxInputBytes: 16_384,
    maxOutputBytes: 4_096,
    maxTokens: 1_024,
    maxAttempts: 2,
  },
  contextRefs: ["sha256:golden-context"],
  prologueRef: AXIP_PROLOGUE_HASH,
});
const payload = canonicalJson(axipRequestPayload(request));
const inlineFrame = encodeAxipRequest(request);
const referencedFrame = encodeAxipRequest(request, { prologue: "reference" });
const response = encodeAxoResponse({
  protocol: "AXIP/1",
  kind: "candidate",
  runId: request.runId,
  nodeId: request.nodeId,
  value: { text: "😀e\u0301", scalars: 3 },
});

const jsonCases = [
  {
    name: "unicode-scalar-key-order",
    input_json: '{"😀":2,"":1,"é":3,"é":4}',
  },
  {
    name: "safe-integer-and-negative-zero",
    input_json: '{"z":-0,"a":9007199254740991}',
  },
].map(({ name, input_json: inputJson }) => {
  const value = JSON.parse(inputJson);
  const canonical = canonicalJson(value);
  return {
    name,
    input_json: inputJson,
    canonical,
    canonical_hash: canonicalHash(value),
  };
});

const vectors = {
  format: "AXIOM-CONFORMANCE/0.1",
  frozen: true,
  versions: {
    language: "0.1",
    air: "AIR/0.1",
    axip: "AXIP/1",
    axlock: "AXLOCK/0.1",
    axlog: "AXLOG/0.1",
    toolchain: "@axiom-lang/core@0.2.0",
  },
  canonical_json: {
    valid: jsonCases,
    rejected: [
      {
        name: "lone-surrogate",
        input_json: '"\\ud800"',
        error: "CanonicalJsonError",
      },
      {
        name: "fraction",
        input_json: "1.5",
        error: "CanonicalJsonError",
      },
      {
        name: "unsafe-integer",
        input_json: "9007199254740992",
        error: "CanonicalJsonError",
      },
      {
        name: "duplicate-key",
        input_json: '{"a":1,"a":2}',
        error: "CanonicalJsonError",
      },
    ],
  },
  program: {
    source_name: "core-001.ax",
    source,
    source_hash: compiled.program.sourceHash,
    semantic_hash: compiled.hash,
    artifact_hash: compiled.artifactHash,
    canonical_air: canonicalJson(compiled.program),
    canonical_air_utf8_bytes: compiled.bytes.byteLength,
    lock: createProgramLock(compiled),
  },
  execution: {
    task: "Main",
    run_id: execution.runId,
    input,
    value: execution.value,
    ledger_entries: execution.ledger.entries,
    ledger_root: execution.ledger.root,
  },
  protocol: {
    prologue_hash: AXIP_PROLOGUE_HASH,
    request_payload: payload,
    request_hash: canonicalHash(axipRequestPayload(request)),
    inline_frame: inlineFrame,
    inline_frame_hash: sha256Text(inlineFrame),
    inline_frame_utf8_bytes: utf8ByteLength(inlineFrame),
    referenced_frame: referencedFrame,
    referenced_frame_hash: sha256Text(referencedFrame),
    referenced_frame_utf8_bytes: utf8ByteLength(referencedFrame),
    candidate_response: response,
    candidate_response_hash: sha256Text(response),
    candidate_response_utf8_bytes: utf8ByteLength(response),
  },
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
