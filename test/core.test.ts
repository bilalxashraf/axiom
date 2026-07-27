import {
  deepEqual,
  equal,
  fail,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FixtureBindings,
  type FixtureConfig,
  type RuntimeBindings,
} from "../src/bindings.ts";
import {
  canonicalHash,
  canonicalJson,
  type JsonObject,
} from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import { AxiomError, CheckError, ParseError } from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { parse } from "../src/parser.ts";
import { runTask, type RunResult } from "../src/vm.ts";

const exampleSource = readFileSync(
  new URL("../../examples/fix.ax", import.meta.url),
  "utf8",
);
const exampleInput = JSON.parse(
  readFileSync(new URL("../../examples/input.json", import.meta.url), "utf8"),
) as JsonObject;
const exampleFixtures = JSON.parse(
  readFileSync(
    new URL("../../examples/fixtures.json", import.meta.url),
    "utf8",
  ),
) as FixtureConfig;

function assertAxiomError(
  error: unknown,
  expectedClass: typeof AxiomError,
  code: string,
  message?: RegExp,
): true {
  ok(error instanceof expectedClass);
  equal(error.code, code);
  if (message !== undefined) {
    match(error.message, message);
  }
  return true;
}

function requireSuccess(result: RunResult): asserts result is Extract<
  RunResult,
  { readonly status: "success" }
> {
  if (result.status !== "success") {
    fail(`${result.error.code}: ${result.error.message}`);
  }
}

function requireFailure(result: RunResult): asserts result is Extract<
  RunResult,
  { readonly status: "failed" }
> {
  if (result.status !== "failed") {
    fail("Expected the task to fail");
  }
}

function forbiddenBindings(calls: string[]): RuntimeBindings {
  return {
    id: "must-not-be-called",
    model: {
      id: "must-not-be-called:model",
      async complete() {
        calls.push("model");
        throw new Error("Replay attempted a live model call");
      },
    },
    async callTool(name) {
      calls.push(`tool:${name}`);
      throw new Error("Replay attempted a live tool call");
    },
    async callValidator(name) {
      calls.push(`validator:${name}`);
      throw new Error("Replay attempted a live validator call");
    },
    async callVerifier(name) {
      calls.push(`verifier:${name}`);
      throw new Error("Replay attempted a live verifier call");
    },
  };
}

test("the checked-in example parses and compiles to the expected AIR shape", () => {
  const ast = parse(exampleSource, "examples/fix.ax");
  equal(ast.version, "0.1");

  const task = ast.declarations.find(
    (declaration) => declaration.kind === "TaskDecl",
  );
  ok(task !== undefined);
  equal(task.name, "Fix");
  deepEqual(
    task.obligations.map((obligation) => obligation.id),
    ["inspected", "applied", "tests"],
  );

  const compiled = compileSource(exampleSource, "examples/fix.ax");
  equal(compiled.program.format, "AIR/0.1");
  equal(compiled.program.tasks.length, 1);
  deepEqual(
    compiled.program.tasks[0]?.operations.map((operation) => operation.op),
    [
      "observe",
      "verify",
      "satisfy",
      "infer",
      "validate",
      "act",
      "verify",
      "satisfy",
      "observe",
      "verify",
      "satisfy",
      "complete",
    ],
  );
  match(compiled.hash, /^sha256:[0-9a-f]{64}$/u);
});

test("compile rejects completion with an unresolved obligation", () => {
  const source = `
axiom 0.1;

proposition Ready event;

task Missing() -> Unit
must {
  ready: Ready;
}
{
  complete unit;
}
`;

  throws(
    () => compileSource(source, "missing.ax"),
    (error: unknown) =>
      assertAxiomError(
        error,
        CheckError,
        "AX1205",
        /pending obligation: ready/u,
      ),
  );
});

test("evidence for one proposition cannot satisfy another proposition", () => {
  const source = `
axiom 0.1;

proposition Inspected event;
proposition Approved event;

extern verifier inspection(value: Text) proves Inspected;

task WrongEvidence(value: Text) -> Unit
must {
  approved: Approved;
}
{
  verify evidence = inspection(value);
  satisfy approved with evidence;
  complete unit;
}
`;

  throws(
    () => compileSource(source, "wrong-evidence.ax"),
    (error: unknown) =>
      assertAxiomError(
        error,
        CheckError,
        "AX1308",
        /Expected Evidence<Approved>/u,
      ),
  );
});

test("an unvalidated Candidate<T> cannot flow into a write tool", () => {
  const source = `
axiom 0.1;

record Plan {
  patch: Text;
}

record Receipt {
  changed: Bool;
}

extern model propose(input: Text) -> Plan
  intent "Propose a patch.";
extern tool apply(plan: Plan) -> Receipt mode write;

task Unsafe(input: Text) -> Receipt
must {}
{
  infer candidate = propose(input)
    limit input_bytes 1024 output_bytes 1024 attempts 1;
  act receipt = apply(candidate) key "unsafe";
  complete receipt;
}
`;

  throws(
    () => compileSource(source, "candidate-to-tool.ax"),
    (error: unknown) =>
      assertAxiomError(
        error,
        CheckError,
        "AX1425",
        /Expected Plan, got Candidate<Plan>/u,
      ),
  );
});

test("an action requires an explicit Text idempotency key", async (t) => {
  const missingKey = `
axiom 0.1;

extern tool write(value: Text) -> Text mode write;

task MissingKey(value: Text) -> Text
must {}
{
  act result = write(value);
  complete result;
}
`;

  await t.test("the parser rejects an omitted key", () => {
    throws(
      () => parse(missingKey, "missing-key.ax"),
      (error: unknown) =>
        assertAxiomError(error, ParseError, "A233", /keyword "key"/u),
    );
  });

  await t.test("the compiler rejects an omitted key through its parse phase", () => {
    throws(
      () => compileSource(missingKey, "missing-key.ax"),
      (error: unknown) =>
        assertAxiomError(error, ParseError, "A233", /keyword "key"/u),
    );
  });

  await t.test("the compiler rejects a non-Text key", () => {
    const numericKey = missingKey.replace(
      "act result = write(value);",
      "act result = write(value) key 7;",
    );
    throws(
      () => compileSource(numericKey, "numeric-key.ax"),
      (error: unknown) =>
        assertAxiomError(
          error,
          CheckError,
          "AX1425",
          /Expected Text, got Int/u,
        ),
    );
  });
});

test("the VM executes the valid example and completes every obligation", async () => {
  const compiled = compileSource(exampleSource, "examples/fix.ax");
  const result = await runTask(compiled, {
    task: "Fix",
    input: exampleInput,
    bindings: new FixtureBindings(exampleFixtures),
    runId: "vm-success",
  });

  requireSuccess(result);
  deepEqual(result.value, { receipt: { changed: true } });

  const effects = result.ledger.entries.filter(
    (entry) => entry.kind === "effect",
  );
  equal(effects.length, 8);

  const satisfied = result.ledger.entries
    .filter((entry) => entry.kind === "obligation")
    .map((entry) => entry.payload);
  deepEqual(satisfied, [
    { obligation: "inspected", status: "satisfied", world_epoch: 0 },
    { obligation: "applied", status: "satisfied", world_epoch: 1 },
    { obligation: "tests", status: "satisfied", world_epoch: 1 },
  ]);
  equal(result.ledger.entries.at(-1)?.kind, "success");
  const header = result.ledger.entries.find((entry) => entry.kind === "run");
  ok(header !== undefined);
  deepEqual((header.payload as JsonObject).trusted_bindings, {
    id: "fixtures",
    fingerprint: canonicalHash(exampleFixtures),
    model_adapter: "fixtures:model",
  });
});

test("a rejecting verifier fails the run before evidence is created", async () => {
  const source = `
axiom 0.1;

record Check {
  ok: Bool;
}

proposition Accepted event;

extern verifier accept(value: Check) proves Accepted;

task Reject(value: Check) -> Unit
must {
  accepted: Accepted;
}
{
  verify evidence = accept(value);
  satisfy accepted with evidence;
  complete unit;
}
`;
  const compiled = compileSource(source, "verifier-rejection.ax");
  const result = await runTask(compiled, {
    task: "Reject",
    input: { value: { ok: false } },
    bindings: new FixtureBindings({
      verifiers: {
        accept: {
          kind: "equals",
          argument: 0,
          path: "ok",
          value: true,
        },
      },
    }),
    runId: "verifier-rejection",
  });

  requireFailure(result);
  equal(result.error.code, "AX2106");
  match(result.error.message, /rejected proposition `Accepted`/u);
  ok(
    !result.ledger.entries.some(
      (entry) =>
        entry.kind === "obligation" &&
        (entry.payload as { readonly status?: unknown }).status === "satisfied",
    ),
  );
});

test("state evidence becomes stale after a later write", () => {
  const source = `
axiom 0.1;

record Receipt {
  changed: Bool;
}

proposition Stable state;

extern tool mutate(value: Text) -> Receipt mode write;
extern verifier stable(value: Text) proves Stable;

task Stale() -> Unit
must {
  stable_state: Stable;
}
{
  verify evidence = stable("snapshot");
  act receipt = mutate("change") key "mutation-1";
  satisfy stable_state with evidence;
  complete unit;
}
`;
  throws(
    () => compileSource(source, "stale-evidence.ax"),
    (error: unknown) =>
      assertAxiomError(
        error,
        CheckError,
        "AX1500",
        /state evidence "evidence" is stale after an act/u,
      ),
  );
});

test("replay is exact, performs no live calls, and detects divergence", async () => {
  const compiled = compileSource(exampleSource, "examples/fix.ax");
  const runId = "replay-conformance";
  const live = await runTask(compiled, {
    task: "Fix",
    input: exampleInput,
    bindings: new FixtureBindings(exampleFixtures),
    runId,
  });
  requireSuccess(live);

  const replayCalls: string[] = [];
  const replay = await runTask(compiled, {
    task: "Fix",
    input: exampleInput,
    bindings: forbiddenBindings(replayCalls),
    replay: live.ledger,
    runId,
  });
  requireSuccess(replay);

  const liveEffects = live.ledger.entries
    .filter((entry) => entry.kind === "effect")
    .map((entry) => entry.payload);
  const replayEffects = replay.ledger.entries
    .filter((entry) => entry.kind === "effect")
    .map((entry) => entry.payload);
  deepEqual(replay.value, live.value);
  deepEqual(replayEffects, liveEffects);
  equal(replay.replayedEffects, liveEffects.length);
  deepEqual(replayCalls, []);

  const divergenceCalls: string[] = [];
  const divergent = await runTask(compiled, {
    task: "Fix",
    input: {
      issue: {
        summary: "A different issue changes the first effect request.",
        terms: ["different"],
      },
    },
    bindings: forbiddenBindings(divergenceCalls),
    replay: live.ledger,
    runId,
  });
  requireFailure(divergent);
  equal(divergent.error.code, "AX3009");
  match(divergent.error.message, /Replay header does not match/u);
  equal(divergent.replayedEffects, 0);
  deepEqual(divergenceCalls, []);

  const tamperedTape = new Ledger();
  let tamperedIntent = false;
  let tamperedEffect = false;
  const tamperRequest = (payload: JsonObject): JsonObject => {
    ok(
      payload.request !== null &&
        typeof payload.request === "object" &&
        !Array.isArray(payload.request),
    );
    return {
      ...payload,
      request: {
        ...(payload.request as JsonObject),
        port: "tampered",
      },
    };
  };
  for (const entry of live.ledger.entries) {
    if (entry.kind === "effect_intent" && !tamperedIntent) {
      tamperedIntent = true;
      tamperedTape.append(
        entry.kind,
        tamperRequest(entry.payload as JsonObject),
      );
    } else if (entry.kind === "effect" && !tamperedEffect) {
      tamperedEffect = true;
      tamperedTape.append(
        entry.kind,
        tamperRequest(entry.payload as JsonObject),
      );
    } else {
      tamperedTape.append(entry.kind, entry.payload);
    }
  }

  const effectDivergenceCalls: string[] = [];
  const effectDivergence = await runTask(compiled, {
    task: "Fix",
    input: exampleInput,
    bindings: forbiddenBindings(effectDivergenceCalls),
    replay: tamperedTape,
    runId,
  });
  requireFailure(effectDivergence);
  equal(effectDivergence.error.code, "AX3007");
  match(effectDivergence.error.message, /Replay diverged at effect 0/u);
  equal(effectDivergence.replayedEffects, 0);
  deepEqual(effectDivergenceCalls, []);
});

test("canonical compilation is byte-for-byte deterministic", () => {
  const first = compileSource(exampleSource, "first/path/fix.ax");
  const second = compileSource(exampleSource, "another/path/fix.ax");

  equal(first.hash, second.hash);
  deepEqual(first.program, second.program);
  deepEqual(first.bytes, second.bytes);
  equal(
    new TextDecoder().decode(first.bytes),
    canonicalJson(first.program),
  );
});
