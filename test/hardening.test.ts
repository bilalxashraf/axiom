import {
  deepEqual,
  equal,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import {
  TextFunctionAdapter,
  type AgentModelAdapter,
} from "../src/adapters.ts";
import { verifyAirProgram } from "../src/air-validator.ts";
import type {
  RuntimeBindings,
} from "../src/bindings.ts";
import {
  canonicalJsonBytes,
  type JsonValue,
} from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import type { CompiledProgram } from "../src/ir.ts";
import {
  AXIP_VERSION,
  encodeAxoResponse,
} from "../src/protocol.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "../src/program-hash.ts";
import { runTask } from "../src/vm.ts";

const INFERENCE_SOURCE = `
axiom 0.1;

record Prompt { text: Text; }
record Plan { answer: Text; }

extern model planner(input: Prompt) -> Plan
  intent "Return one answer.";
extern validator accept(raw: Candidate<Plan>) -> Plan;

task Main(input: Prompt) -> Plan
must {
}
{
  infer raw = planner(input)
    limit input_bytes 4096 output_bytes 1024 attempts 3;
  validate plan = accept(raw);
  complete plan;
}
`;

function inferenceBindings(model: AgentModelAdapter): RuntimeBindings {
  return {
    id: "hardening",
    model,
    async callTool(): Promise<JsonValue> {
      throw new Error("No tool call expected");
    },
    async callValidator(_name, args): Promise<JsonValue> {
      return args[0] as JsonValue;
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("No verifier call expected");
    },
  };
}

test("a non-retryable model failure performs exactly one attempt", async () => {
  let calls = 0;
  const model = new TextFunctionAdapter("non-retryable", (_frame, invocation) => {
    calls += 1;
    return encodeAxoResponse({
      protocol: AXIP_VERSION,
      kind: "fail",
      runId: invocation.request.runId,
      nodeId: invocation.request.nodeId,
      error: {
        code: "NO_VALID_CANDIDATE",
        message: "The model cannot solve this input.",
        retryable: false,
      },
    });
  });
  const result = await runTask(compileSource(INFERENCE_SOURCE), {
    task: "Main",
    input: { input: { text: "x" } },
    bindings: inferenceBindings(model),
    runId: "non-retryable",
  });
  equal(result.status, "failed");
  if (result.status === "failed") {
    equal(result.error.code, "AX2101");
    match(result.error.message, /cannot solve/u);
  }
  equal(calls, 1);
  equal(
    result.ledger.entries.filter((entry) => entry.kind === "effect").length,
    1,
  );
});

test("failed model attempts are recorded and replayed before a later success", async () => {
  let calls = 0;
  const model = new TextFunctionAdapter("retry", (_frame, invocation) => {
    calls += 1;
    if (calls === 1) {
      return "not-an-axo-envelope";
    }
    return encodeAxoResponse({
      protocol: AXIP_VERSION,
      kind: "candidate",
      runId: invocation.request.runId,
      nodeId: invocation.request.nodeId,
      value: { answer: "ok" },
    });
  });
  const compiled = compileSource(INFERENCE_SOURCE);
  const live = await runTask(compiled, {
    task: "Main",
    input: { input: { text: "x" } },
    bindings: inferenceBindings(model),
    runId: "retry-replay",
  });
  equal(live.status, "success");
  equal(calls, 2);
  equal(
    live.ledger.entries.filter((entry) => entry.kind === "effect").length,
    3,
  );

  const replay = await runTask(compiled, {
    task: "Main",
    input: { input: { text: "x" } },
    runId: "retry-replay",
    replay: live.ledger,
  });
  equal(replay.status, "success");
  equal(replay.replayedEffects, 3);
  equal(calls, 2);
});

test("Text literal `unit` remains text at an effect boundary", async () => {
  const source = `
axiom 0.1;
record Result { value: Text; }
extern tool echo(value: Text) -> Result mode write;
task Main() -> Result must {} {
  act result = echo("unit") key "same";
  complete result;
}
`;
  let seen: JsonValue | undefined;
  const neverModel = new TextFunctionAdapter("unused", () => {
    throw new Error("Model must not run");
  });
  const bindings: RuntimeBindings = {
    id: "unit-text",
    model: neverModel,
    async callTool(_name, _mode, args): Promise<JsonValue> {
      seen = args[0];
      return { value: args[0] as JsonValue };
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("Validator must not run");
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("Verifier must not run");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "Main",
    input: {},
    bindings,
    runId: "unit-text",
  });
  equal(result.status, "success");
  equal(seen, "unit");
  if (result.status === "success") {
    deepEqual(result.value, { value: "unit" });
  }
});

test("safe-integer overflow fails before an external write", async () => {
  const source = `
axiom 0.1;
record Result { value: Int; }
extern tool save(value: Int) -> Result mode write;
task Main(value: Int) -> Result must {} {
  act result = save(value + 1) key "overflow";
  complete result;
}
`;
  let toolCalls = 0;
  const bindings: RuntimeBindings = {
    id: "overflow",
    model: new TextFunctionAdapter("unused", () => {
      throw new Error("Model must not run");
    }),
    async callTool(): Promise<JsonValue> {
      toolCalls += 1;
      return { value: 0 };
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("Validator must not run");
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("Verifier must not run");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "Main",
    input: { value: Number.MAX_SAFE_INTEGER },
    bindings,
    runId: "overflow",
  });
  equal(result.status, "failed");
  if (result.status === "failed") {
    equal(result.error.code, "AX2020");
  }
  equal(toolCalls, 0);
});

test("every non-model effect inherits a deadline and cancellation signal", async () => {
  const source = `
axiom 0.1;
extern tool wait(value: Text) -> Text mode read;
task Main(value: Text) -> Text must {} {
  observe result = wait(value);
  complete result;
}
`;
  let aborted = false;
  const bindings: RuntimeBindings = {
    id: "deadline",
    model: new TextFunctionAdapter("unused", () => {
      throw new Error("Model must not run");
    }),
    async callTool(_name, _mode, _args, context): Promise<JsonValue> {
      return new Promise<JsonValue>((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(context.signal?.reason);
          },
          { once: true },
        );
      });
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("Validator must not run");
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("Verifier must not run");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "Main",
    input: { value: "x" },
    bindings,
    effectTimeoutMs: 10,
    runId: "effect-deadline",
  });
  equal(result.status, "failed");
  if (result.status === "failed") {
    equal(result.error.code, "AX2138");
  }
  equal(aborted, true);
  deepEqual(
    result.ledger.entries
      .filter((entry) =>
        entry.kind === "effect_intent" || entry.kind === "effect"
      )
      .map((entry) => entry.kind),
    ["effect_intent", "effect"],
  );
});

test("a failed write dispatch is recorded as uncertain for reconciliation", async () => {
  const source = `
axiom 0.1;
extern tool save(value: Text) -> Text mode write;
task Main(value: Text) -> Text must {} {
  act result = save(value) key "stable";
  complete result;
}
`;
  const bindings: RuntimeBindings = {
    id: "uncertain-write",
    model: new TextFunctionAdapter("unused", () => {
      throw new Error("Model must not run");
    }),
    async callTool(_name, _mode, _args, context): Promise<JsonValue> {
      return new Promise<JsonValue>((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => reject(context.signal?.reason),
          { once: true },
        );
      });
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("Validator must not run");
    },
    async callVerifier(): Promise<boolean> {
      throw new Error("Verifier must not run");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "Main",
    input: { value: "x" },
    bindings,
    effectTimeoutMs: 10,
    runId: "uncertain-write",
  });
  equal(result.status, "failed");
  const effect = result.ledger.entries.find((entry) => entry.kind === "effect");
  ok(effect !== undefined);
  const payload = effect.payload as {
    readonly response?: {
      readonly ok?: boolean;
      readonly uncertain?: boolean;
    };
  };
  equal(payload.response?.ok, false);
  equal(payload.response?.uncertain, true);
});

test("the VM rejects mismatched CompiledProgram seals", async () => {
  const compiled = compileSource(INFERENCE_SOURCE);
  const forged: CompiledProgram = {
    ...compiled,
    hash:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  const result = await runTask(forged, {
    task: "Main",
    input: { input: { text: "x" } },
    runId: "bad-seal",
  });
  equal(result.status, "failed");
  if (result.status === "failed") {
    equal(result.error.code, "AX2019");
  }
});

test("rehashed AIR still cannot send a Candidate directly to a tool", async () => {
  const source = `
axiom 0.1;
record Plan { answer: Text; }
record Receipt { saved: Bool; }
extern model planner(input: Text) -> Plan intent "Return a plan.";
extern validator accept(raw: Candidate<Plan>) -> Plan;
extern tool save(plan: Plan) -> Receipt mode write;
task Main(input: Text) -> Receipt must {} {
  infer raw = planner(input)
    limit input_bytes 4096 output_bytes 1024 attempts 1;
  validate plan = accept(raw);
  act receipt = save(plan) key "save";
  complete receipt;
}
`;
  const original = compileSource(source);
  const program = structuredClone(original.program);
  const task = program.tasks[0];
  ok(task !== undefined);
  const operations = task.operations
    .filter((operation) => operation.op !== "validate")
    .map((operation) =>
      operation.op === "act"
        ? {
            ...operation,
            arguments: [{ kind: "variable" as const, name: "raw" }],
          }
        : operation,
    );
  const forgedProgram = {
    ...program,
    tasks: [{ ...task, operations }],
  };
  const forged: CompiledProgram = {
    program: forgedProgram,
    hash: semanticProgramHash(forgedProgram),
    artifactHash: artifactProgramHash(forgedProgram),
    bytes: canonicalJsonBytes(forgedProgram),
  };
  let toolCalls = 0;
  const model = new TextFunctionAdapter("candidate", (_frame, invocation) =>
    encodeAxoResponse({
      protocol: AXIP_VERSION,
      kind: "candidate",
      runId: invocation.request.runId,
      nodeId: invocation.request.nodeId,
      value: { answer: "x" },
    }),
  );
  const bindings: RuntimeBindings = {
    ...inferenceBindings(model),
    async callTool(): Promise<JsonValue> {
      toolCalls += 1;
      return { saved: true };
    },
  };
  const result = await runTask(forged, {
    task: "Main",
    input: { input: "x" },
    bindings,
    runId: "candidate-forge",
  });
  equal(result.status, "failed");
  equal(toolCalls, 0);
});

test("operators rejected by the runtime are also rejected statically", () => {
  const invalidBodies = [
    "complete flag < flag;",
    "complete len(flag);",
    "complete contains(values, flag);",
    "complete sort(flags);",
  ];
  const declarations = [
    "task Main(flag: Bool) -> Bool must {}",
    "task Main(flag: Bool) -> Int must {}",
    "task Main(values: List<Text>, flag: Bool) -> Bool must {}",
    "task Main(flags: List<Bool>) -> List<Bool> must {}",
  ];
  for (const [index, body] of invalidBodies.entries()) {
    throws(
      () =>
        compileSource(`
axiom 0.1;
${declarations[index]} {
  ${body}
}
`),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        /^AX14(?:15|16|17|24)$/u.test(error.code),
    );
  }
});

test("model intents must be non-empty at source and AIR boundaries", () => {
  throws(
    () =>
      compileSource(`
axiom 0.1;
record Output { value: Text; }
extern model empty() -> Output intent "";
task Main() -> Unit must {} { fail "not run"; }
`),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "AX1005",
  );

  const exactLimit = "😀".repeat(1_024);
  const compiled = compileSource(`
axiom 0.1;
record Output { value: Text; }
extern model exact() -> Output intent "${exactLimit}";
task Main() -> Unit must {} { fail "not run"; }
`);
  verifyAirProgram(compiled.program);

  throws(
    () =>
      compileSource(`
axiom 0.1;
record Output { value: Text; }
extern model oversized() -> Output intent "${"😀".repeat(1_025)}";
task Main() -> Unit must {} { fail "not run"; }
`),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "AX1051",
  );

  const model = compiled.program.ports[0];
  if (model?.kind !== "model") {
    throw new Error("Expected the test fixture to contain one model port");
  }
  const forged = {
    ...compiled.program,
    ports: [
      {
        ...model,
        intent: "😀".repeat(1_025),
      },
    ],
  };
  throws(() => verifyAirProgram(forged), /exceed 1024 Unicode scalar values/u);
});

test("run identity is validated even when a task performs no inference", async () => {
  const compiled = compileSource(`
axiom 0.1;
task Main() -> Unit must {} { complete unit; }
`);
  const result = await runTask(
    compiled,
    {
      task: "Main",
      input: {},
      runId: "",
    },
  );
  equal(result.status, "failed");
  if (result.status === "failed") {
    equal(result.error.code, "AX2136");
  }

  const scalarLimit = await runTask(compiled, {
    task: "Main",
    input: {},
    runId: "😀".repeat(1_024),
  });
  equal(scalarLimit.status, "success");

  const overScalarLimit = await runTask(compiled, {
    task: "Main",
    input: {},
    runId: "😀".repeat(1_025),
  });
  equal(overScalarLimit.status, "failed");
  if (overScalarLimit.status === "failed") {
    equal(overScalarLimit.error.code, "AX2136");
  }
});

test("identifiers are bounded before they can create oversized protocol identities", () => {
  throws(
    () =>
      compileSource(
        `axiom 0.1; task ${"A".repeat(257)}() -> Unit must {} { complete unit; }`,
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "A107",
  );
  throws(
    () =>
      compileSource(
        'axiom 0.1; task Main() -> Text must {} { complete "\\ud800"; }',
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "A108",
  );
});
