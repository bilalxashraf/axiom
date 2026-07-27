import assert from "node:assert/strict";
import test from "node:test";

import { TextFunctionAdapter } from "../src/adapters.ts";
import type { RuntimeBindings } from "../src/bindings.ts";
import { utf8ByteLength, type JsonValue } from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import {
  AXIP_PROLOGUE_HASH,
  AXIP_VERSION,
  axipRequestHash,
  createAxipRequest,
  decodeAxipRequest,
  encodeAxoResponse,
  encodeAxipRequest,
  type AxipRequest,
} from "../src/protocol.ts";
import { schema } from "../src/schema.ts";
import { runTask } from "../src/vm.ts";

const PROGRAM_HASH =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const;

function compactRequest(
  maxInputBytes: number,
  prologueRef?: string,
): AxipRequest {
  return createAxipRequest({
    runId: "budget-run",
    programHash: PROGRAM_HASH,
    nodeId: "Task:1:model",
    operation: "Classify the input.",
    inputSchema: schema.record([
      schema.field("text", schema.string()),
    ]),
    outputSchema: schema.enum(["yes", "no"]),
    inputs: { text: "héllo" },
    activeObligations: [],
    allowedResponses: ["candidate", "fail"],
    budget: {
      maxInputBytes,
      maxOutputBytes: 1_024,
      maxTokens: 512,
      maxAttempts: 1,
    },
    contextRefs: [],
    ...(prologueRef === undefined ? {} : { prologueRef }),
  });
}

test("AXIP enforces a UTF-8 frame byte budget without truncation", () => {
  const request = compactRequest(4_096);
  const frame = encodeAxipRequest(request);
  assert.equal(utf8ByteLength(frame), Buffer.byteLength(frame, "utf8"));
  assert.ok(utf8ByteLength(frame) <= request.budget.maxInputBytes);

  const undersized = compactRequest(64);
  assert.throws(
    () => encodeAxipRequest(undersized),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { readonly code?: string }).code,
        "AXIP_INPUT_BUDGET",
      );
      return true;
    },
  );
});

test("a cached prologue reference reduces bytes without changing request semantics", () => {
  const request = compactRequest(4_096, AXIP_PROLOGUE_HASH);
  const inline = encodeAxipRequest(request, { prologue: "inline" });
  const referenced = encodeAxipRequest(request, { prologue: "reference" });

  assert.ok(utf8ByteLength(referenced) < utf8ByteLength(inline));
  assert.equal(
    axipRequestHash(decodeAxipRequest(inline)),
    axipRequestHash(decodeAxipRequest(referenced)),
  );
  assert.equal(axipRequestHash(decodeAxipRequest(inline)), axipRequestHash(request));
});

const SOURCE_SENTINEL = "FULL_SOURCE_SENTINEL_MUST_NOT_REACH_MODEL";
const UNRELATED_RECORD = "UnrelatedRecord";
const UNRELATED_FIELD = "unrelated_secret_payload";

const source = `
axiom 0.1;

// ${SOURCE_SENTINEL}
record FirstInput {
  seed: Text;
}

record FirstOutput {
  answer: Text;
}

record SecondInput {
  prior: FirstOutput;
}

record SecondOutput {
  final: Text;
}

record ${UNRELATED_RECORD} {
  ${UNRELATED_FIELD}: Text;
}

extern model first(input: FirstInput) -> FirstOutput
  intent "FIRST_ACTIVE_NODE";
extern model second(input: SecondInput) -> SecondOutput
  intent "SECOND_ACTIVE_NODE";

extern validator accept_first(raw: Candidate<FirstOutput>) -> FirstOutput;
extern validator accept_second(raw: Candidate<SecondOutput>) -> SecondOutput;

task Run(input: FirstInput) -> SecondOutput
must {
}
{
  infer raw_first = first(input)
    limit input_bytes 8192 output_bytes 1024 attempts 1;
  validate first_value = accept_first(raw_first);

  infer raw_second = second(SecondInput { prior: first_value })
    limit input_bytes 8192 output_bytes 1024 attempts 1;
  validate second_value = accept_second(raw_second);

  complete second_value;
}
`;

test("VM inference frames contain only the active node and reachable records", async () => {
  const frames: string[] = [];
  const model = new TextFunctionAdapter(
    "capture-text-model",
    (frame, invocation) => {
      frames.push(frame);
      const value =
        invocation.request.operation === "FIRST_ACTIVE_NODE"
          ? { answer: "first result" }
          : { final: "second result" };
      return encodeAxoResponse({
        protocol: AXIP_VERSION,
        kind: "candidate",
        runId: invocation.request.runId,
        nodeId: invocation.request.nodeId,
        value,
      });
    },
  );
  const bindings: RuntimeBindings = {
    id: "frame-capture",
    model,
    async callTool(): Promise<JsonValue> {
      throw new Error("No tool call is declared by this test program.");
    },
    async callValidator(
      _name,
      arguments_,
    ): Promise<JsonValue> {
      return arguments_[0] as JsonValue;
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("No verifier call is declared by this test program.");
    },
  };

  const result = await runTask(compileSource(source, "efficiency.ax"), {
    task: "Run",
    input: { input: { seed: "start" } },
    bindings,
    runId: "efficiency-run",
  });

  assert.equal(result.status, "success");
  assert.deepEqual(
    result.status === "success" ? result.value : undefined,
    { final: "second result" },
  );
  assert.equal(frames.length, 2);

  const firstFrame = frames[0] as string;
  const secondFrame = frames[1] as string;
  assert.match(firstFrame, /FIRST_ACTIVE_NODE/u);
  assert.doesNotMatch(firstFrame, /SECOND_ACTIVE_NODE/u);
  assert.match(secondFrame, /SECOND_ACTIVE_NODE/u);
  assert.doesNotMatch(secondFrame, /FIRST_ACTIVE_NODE/u);

  for (const frame of frames) {
    assert.notEqual(frame, source);
    assert.doesNotMatch(frame, new RegExp(SOURCE_SENTINEL, "u"));
    assert.doesNotMatch(frame, new RegExp(UNRELATED_RECORD, "u"));
    assert.doesNotMatch(frame, new RegExp(UNRELATED_FIELD, "u"));

    const decoded = decodeAxipRequest(frame);
    assert.equal(decoded.nodeId.split(":").length, 3);
    assert.equal(
      Object.hasOwn(decoded.schemaDefinitions ?? {}, UNRELATED_RECORD),
      false,
    );
  }
});
