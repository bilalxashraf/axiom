import {
  deepEqual,
  equal,
  fail,
  match,
  notEqual,
  ok,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import {
  FixtureBindings,
  type RuntimeBindings,
} from "../src/bindings.ts";
import {
  canonicalJsonBytes,
  type JsonValue,
} from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import { CheckError, ParseError } from "../src/errors.ts";
import { verifyAirProgram } from "../src/air-validator.ts";
import { createProgramLock } from "../src/lock.ts";
import { effectsFromLedger, Ledger } from "../src/ledger.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "../src/program-hash.ts";
import { runTask, type RunResult } from "../src/vm.ts";

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
    fail("Expected failure");
  }
}

const branchSource = `
axiom 0.2;

extern tool true_path() -> Unit mode read;
extern tool false_path() -> Unit mode read;

task Branch(flag: Bool) -> Bool
must {}
{
  if flag then {
    observe true_receipt = true_path();
  } else {
    observe false_receipt = false_path();
  }
  complete flag;
}
`;

test("Core 0.2 compiles sequence and exhaustive conditionals to preorder AIR", () => {
  const compiled = compileSource(branchSource, "branch.ax");
  equal(compiled.program.format, "AIR/0.2");
  equal(compiled.program.language, "0.2");
  const operations = compiled.program.tasks[0]?.operations;
  ok(operations !== undefined);
  equal(operations[0]?.op, "if");
  equal(operations[0]?.site, 0);
  if (operations[0]?.op !== "if") {
    fail("Expected if operation");
  }
  deepEqual(operations[0].then.map((operation) => operation.site), [1]);
  deepEqual(operations[0].otherwise.map((operation) => operation.site), [2]);
  equal(operations[1]?.site, 3);
  verifyAirProgram(compiled.program);
});

test("if evaluates once and executes exactly one branch", async () => {
  const compiled = compileSource(branchSource, "branch.ax");
  for (const flag of [true, false]) {
    const result = await runTask(compiled, {
      task: "Branch",
      input: { flag },
      bindings: new FixtureBindings({
        tools: {
          true_path: [null],
          false_path: [null],
        },
      }),
      runId: `branch-${String(flag)}`,
    });
    requireSuccess(result);
    equal(result.value, flag);
    const branch = result.ledger.entries.find(
      (entry) => entry.kind === "branch",
    );
    deepEqual(branch?.payload, {
      site: 0,
      iterations: [],
      taken: flag ? "then" : "else",
    });
    const effects = result.ledger.entries.filter(
      (entry) => entry.kind === "effect",
    );
    equal(effects.length, 1);
    match(
      JSON.stringify(effects[0]?.payload),
      flag ? /true_path/u : /false_path/u,
    );
  }
});

test("sequence awaits each step and failure prevents every later effect", async () => {
  const source = `
axiom 0.2;
extern tool first() -> Unit mode read;
extern tool never() -> Unit mode read;
task Ordered() -> Unit must {} {
  observe one = first();
  assert false;
  observe skipped = never();
  complete unit;
}
`;
  const calls: string[] = [];
  const bindings: RuntimeBindings = {
    id: "ordered",
    model: {
      id: "unused",
      async complete() {
        throw new Error("model must not be called");
      },
    },
    async callTool(name) {
      calls.push(name);
      return null;
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("validator must not be called");
    },
    async callVerifier() {
      throw new Error("verifier must not be called");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "Ordered",
    input: {},
    bindings,
    runId: "ordered",
  });
  requireFailure(result);
  equal(result.error.code, "AX2113");
  deepEqual(calls, ["first"]);
});

test("conditions must be validated Bool values and branch locals cannot escape", () => {
  throws(
    () =>
      compileSource(
        branchSource.replace("flag: Bool", "flag: Text"),
        "wrong-condition.ax",
      ),
    (error: unknown) =>
      error instanceof CheckError &&
      error.code === "AX1425" &&
      /Expected Bool, got Text/u.test(error.message),
  );

  const candidate = `
axiom 0.2;
extern model decide() -> Bool intent "Return a decision.";
task CandidateBranch() -> Unit must {} {
  infer raw = decide()
    limit input_bytes 128 output_bytes 128 attempts 1;
  if raw then {} else {}
  complete unit;
}
`;
  throws(
    () => compileSource(candidate, "candidate-condition.ax"),
    (error: unknown) =>
      error instanceof CheckError && /Candidate<Bool>/u.test(error.message),
  );

  const leaking = branchSource.replace("complete flag;", "complete true_receipt;");
  throws(
    () => compileSource(leaking, "branch-leak.ax"),
    (error: unknown) =>
      error instanceof CheckError && /Unknown binding `true_receipt`/u.test(error.message),
  );
});

test("every conditional path must leave obligations in the same certified state", () => {
  const source = `
axiom 0.2;
proposition Checked event;
extern verifier check_true() proves Checked;
extern verifier check_false() proves Checked;
task CheckedBranch(flag: Bool) -> Unit must { checked: Checked; } {
  if flag then {
    verify true_proof = check_true();
    satisfy checked with true_proof;
  } else {
    verify false_proof = check_false();
    satisfy checked with false_proof;
  }
  complete unit;
}
`;
  ok(compileSource(source).program.format === "AIR/0.2");
  throws(
    () =>
      compileSource(
        source.replace("satisfy checked with false_proof;", "assert true;"),
      ),
    (error: unknown) =>
      error instanceof CheckError &&
      error.code === "AX1322" &&
      /obligation `checked`/u.test(error.message),
  );
});

test("one conditional branch may fail while the other continues", async () => {
  const source = `
axiom 0.2;
task Guard(allowed: Bool) -> Unit must {} {
  if allowed then {
    assert true;
  } else {
    fail "Denied by the explicit guard.";
  }
  complete unit;
}
`;
  const compiled = compileSource(source);
  const allowed = await runTask(compiled, {
    task: "Guard",
    input: { allowed: true },
    runId: "guard-allowed",
  });
  requireSuccess(allowed);
  const denied = await runTask(compiled, {
    task: "Guard",
    input: { allowed: false },
    runId: "guard-denied",
  });
  requireFailure(denied);
  equal(denied.error.code, "AX2116");
  match(denied.error.message, /explicit guard/u);
});

test("Core 0.1 remains frozen and rejects new control-flow syntax", () => {
  throws(
    () => compileSource(branchSource.replace("axiom 0.2;", "axiom 0.1;")),
    (error: unknown) =>
      error instanceof ParseError &&
      error.code === "A242" &&
      /Core 0\.2/u.test(error.message),
  );
});

const repeatSource = `
axiom 0.2;

extern tool poll() -> Bool mode read;

task Wait() -> Unit
must {}
{
  repeat max 3 {
    observe done = poll();
  } until done;
  complete unit;
}
`;

test("repeat is post-test, exits early, and refreshes its lexical frame", async () => {
  const compiled = compileSource(repeatSource, "repeat.ax");
  const result = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [false, false, true] } }),
    runId: "repeat-success",
  });
  requireSuccess(result);
  const loops = result.ledger.entries
    .filter((entry) => entry.kind === "loop")
    .map((entry) => entry.payload);
  deepEqual(loops, [
    { site: 0, iteration: 1, iterations: [1], until: false },
    { site: 0, iteration: 2, iterations: [2], until: false },
    { site: 0, iteration: 3, iterations: [3], until: true },
  ]);
  equal(
    result.ledger.entries.filter((entry) => entry.kind === "effect").length,
    3,
  );
});

test("repeat exhaustion fails after exactly max iterations", async () => {
  const compiled = compileSource(repeatSource, "repeat.ax");
  const result = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [false, false, false] } }),
    runId: "repeat-exhausted",
  });
  requireFailure(result);
  equal(result.error.code, "AX2140");
  match(result.error.message, /exhausted its 3-iteration bound/u);
  equal(
    result.ledger.entries.filter((entry) => entry.kind === "effect").length,
    3,
  );
  equal(
    result.ledger.entries.filter((entry) => entry.kind === "loop").length,
    3,
  );
});

test("repeat bounds, observable progress, and loop-local conditions are certified", () => {
  throws(
    () => compileSource(repeatSource.replace("max 3", "max 0")),
    (error: unknown) => error instanceof ParseError,
  );
  throws(
    () => compileSource(repeatSource.replace("max 3", "max 1025")),
    (error: unknown) =>
      error instanceof CheckError && error.code === "AX1324",
  );
  throws(
    () =>
      compileSource(`
axiom 0.2;
task Spin(done: Bool) -> Unit must {} {
  repeat max 2 { assert true; } until done;
  complete unit;
}`),
    (error: unknown) =>
      error instanceof CheckError && error.code === "AX1327",
  );
  throws(
    () =>
      compileSource(
        repeatSource.replace("until done", "until true"),
        "constant-until.ax",
      ),
    (error: unknown) =>
      error instanceof CheckError && error.code === "AX1328",
  );
});

test("loop invocation addresses and write keys distinguish intended iterations", async () => {
  const source = `
axiom 0.2;
extern tool write(value: Text) -> Unit mode write;
extern tool poll() -> Bool mode read;
task RetryWrite() -> Unit must {} {
  repeat max 2 {
    act receipt = write("same") key "stable-author-key";
    observe done = poll();
  } until done;
  complete unit;
}
`;
  const nodeIds: string[] = [];
  const idempotencyKeys: string[] = [];
  let poll = 0;
  const bindings: RuntimeBindings = {
    id: "capture",
    model: {
      id: "unused",
      async complete() {
        throw new Error("model must not be called");
      },
    },
    async callTool(name, _mode, _arguments, context) {
      nodeIds.push(context.nodeId);
      if (context.idempotencyKey !== undefined) {
        idempotencyKeys.push(context.idempotencyKey);
      }
      if (name === "poll") {
        poll += 1;
        return poll === 2;
      }
      return null;
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("validator must not be called");
    },
    async callVerifier() {
      throw new Error("verifier must not be called");
    },
  };
  const result = await runTask(compileSource(source), {
    task: "RetryWrite",
    input: {},
    bindings,
    runId: "iteration-addresses",
  });
  requireSuccess(result);
  deepEqual(nodeIds, [
    "RetryWrite:1@1:write",
    "RetryWrite:2@1:poll",
    "RetryWrite:1@2:write",
    "RetryWrite:2@2:poll",
  ]);
  equal(idempotencyKeys.length, 2);
  notEqual(idempotencyKeys[0], idempotencyKeys[1]);
});

test("recursive lock bounds use branch maxima and repeat multiplication", () => {
  const branchLock = createProgramLock(compileSource(branchSource));
  equal(branchLock.format, "AXLOCK/0.2");
  deepEqual(branchLock.tasks[0], {
    name: "Branch",
    ports: ["false_path", "true_path"],
    operation_bound: 3,
    effect_bound: 1,
    model_attempt_bound: 0,
    write_bound: 0,
    task_hash: branchLock.tasks[0]?.task_hash,
  });

  const repeatLock = createProgramLock(compileSource(repeatSource));
  deepEqual(repeatLock.tasks[0], {
    name: "Wait",
    ports: ["poll"],
    operation_bound: 5,
    effect_bound: 3,
    model_attempt_bound: 0,
    write_bound: 0,
    task_hash: repeatLock.tasks[0]?.task_hash,
  });
});

test("repeat remains compact instead of unrolling its static bound", () => {
  const once = compileSource(repeatSource.replace("max 3", "max 1"));
  const thousand = compileSource(repeatSource.replace("max 3", "max 1000"));
  ok(thousand.bytes.byteLength - once.bytes.byteLength <= 3);
  const air = JSON.stringify(thousand.program);
  equal(air.match(/"port":"poll"/gu)?.length, 1);
  equal(createProgramLock(thousand).tasks[0]?.effect_bound, 1000);
});

test("live and replay runs reproduce the exact control trace without live calls", async () => {
  const compiled = compileSource(repeatSource);
  const live = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [false, true] } }),
    runId: "control-replay",
  });
  requireSuccess(live);
  const replay = await runTask(compiled, {
    task: "Wait",
    input: {},
    replay: live.ledger,
    runId: "control-replay",
  });
  requireSuccess(replay);
  deepEqual(
    replay.ledger.entries
      .filter((entry) => entry.kind === "loop")
      .map((entry) => entry.payload),
    live.ledger.entries
      .filter((entry) => entry.kind === "loop")
      .map((entry) => entry.payload),
  );
  equal(replay.replayedEffects, 2);
});

test("the independent AIR/0.2 verifier rejects forged recursive control flow", () => {
  const repeat = structuredClone(
    compileSource(repeatSource).program,
  ) as any;
  repeat.tasks[0].operations[0].maxIterations = 1025;
  throws(
    () => verifyAirProgram(repeat),
    (error: unknown) =>
      error instanceof CheckError && /cannot exceed 1024/u.test(error.message),
  );

  const duplicateSite = structuredClone(
    compileSource(branchSource).program,
  ) as any;
  duplicateSite.tasks[0].operations[0].then[0].site = 0;
  throws(
    () => verifyAirProgram(duplicateSite),
    (error: unknown) =>
      error instanceof CheckError && /expected 1, got 0/u.test(error.message),
  );

  const leaking = structuredClone(
    compileSource(branchSource).program,
  ) as any;
  leaking.tasks[0].operations[1].value = {
    kind: "variable",
    name: "true_receipt",
  };
  throws(
    () => verifyAirProgram(leaking),
    (error: unknown) =>
      error instanceof CheckError && /unknown binding "true_receipt"/u.test(error.message),
  );

  const pair = structuredClone(compileSource(branchSource).program) as any;
  pair.format = "AIR/0.1";
  throws(
    () => verifyAirProgram(pair),
    (error: unknown) =>
      error instanceof CheckError && /paired format\/language/u.test(error.message),
  );
});

test("AXLOCK creation re-verifies self-consistent hostile AIR", () => {
  const program = structuredClone(compileSource(repeatSource).program) as any;
  program.tasks[0].operations[0].maxIterations = -3;
  const forged = {
    hash: semanticProgramHash(program),
    artifactHash: artifactProgramHash(program),
    bytes: canonicalJsonBytes(program),
    program,
  };
  throws(
    () => createProgramLock(forged),
    (error: unknown) =>
      error instanceof CheckError && /greater than or equal to 1/u.test(error.message),
  );
});

test("hostile AIR cannot make a Candidate<Bool> control an if", () => {
  const source = `
axiom 0.2;
extern model decide() -> Bool intent "Return one decision.";
extern validator trust(raw: Candidate<Bool>) -> Bool;
task Decide() -> Unit must {} {
  infer raw = decide()
    limit input_bytes 128 output_bytes 128 attempts 1;
  validate choice = trust(raw);
  if choice then {} else {}
  complete unit;
}
`;
  const program = structuredClone(compileSource(source).program) as any;
  program.tasks[0].operations[2].condition = {
    kind: "variable",
    name: "raw",
  };
  throws(
    () => verifyAirProgram(program),
    (error: unknown) =>
      error instanceof CheckError && /Candidate<Bool>/u.test(error.message),
  );
});

test("nested repeat products are rejected above the portable task budget", () => {
  const source = `
axiom 0.2;
extern tool poll() -> Bool mode read;
task TooLarge() -> Unit must {} {
  repeat max 1024 {
    repeat max 1024 {
      observe inner_done = poll();
    } until inner_done;
    observe outer_done = poll();
  } until outer_done;
  complete unit;
}
`;
  throws(
    () => compileSource(source, "too-large.ax"),
    (error: unknown) =>
      error instanceof CheckError && /worst-case operation bound/u.test(error.message),
  );
});

test("tampered control transcripts fail replay even when effects are intact", async () => {
  const compiled = compileSource(repeatSource);
  const live = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [false, true] } }),
    runId: "tampered-control",
  });
  requireSuccess(live);
  const tampered = new Ledger();
  let changed = false;
  for (const entry of live.ledger.entries) {
    if (entry.kind === "loop" && !changed) {
      changed = true;
      tampered.append("loop", {
        ...(entry.payload as Record<string, JsonValue>),
        site: 99,
      });
    } else {
      tampered.append(entry.kind, entry.payload);
    }
  }
  const replay = await runTask(compiled, {
    task: "Wait",
    input: {},
    replay: tampered,
    runId: "tampered-control",
  });
  requireFailure(replay);
  equal(replay.error.code, "AX3027");
  match(replay.error.message, /transition transcript diverged/u);
});

test("reordering a valid control entry across an effect fails replay", async () => {
  const compiled = compileSource(repeatSource);
  const live = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [true] } }),
    runId: "reordered-control",
  });
  requireSuccess(live);
  const reordered = new Ledger();
  const entries = live.ledger.entries;
  const loop = entries.find((entry) => entry.kind === "loop");
  ok(loop !== undefined);
  for (const entry of entries) {
    if (entry.kind === "run") {
      reordered.append(entry.kind, entry.payload);
      reordered.append(loop.kind, loop.payload);
    } else if (entry !== loop) {
      reordered.append(entry.kind, entry.payload);
    }
  }
  const replay = await runTask(compiled, {
    task: "Wait",
    input: {},
    replay: reordered,
    runId: "reordered-control",
  });
  requireFailure(replay);
  equal(replay.error.code, "AX3027");
});

test("the VM executes a detached immutable AIR snapshot across awaits", async () => {
  const compiled = compileSource(repeatSource);
  let calls = 0;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const bindings: RuntimeBindings = {
    id: "mutation-test",
    model: {
      id: "unused",
      async complete() {
        throw new Error("model must not be called");
      },
    },
    async callTool() {
      calls += 1;
      if (calls === 1) {
        enteredFirst();
        await release;
      }
      return calls >= 5;
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("validator must not be called");
    },
    async callVerifier() {
      throw new Error("verifier must not be called");
    },
  };
  const running = runTask(compiled, {
    task: "Wait",
    input: {},
    bindings,
    runId: "air-snapshot",
  });
  await entered;
  const mutable = compiled.program as any;
  mutable.tasks[0].operations[0].maxIterations = 5;
  releaseFirst();
  const result = await running;
  requireFailure(result);
  equal(result.error.code, "AX2140");
  equal(calls, 3);
});

test("completed ledgers are terminal-sealed and replay uses an immutable snapshot", async () => {
  const compiled = compileSource(repeatSource);
  const live = await runTask(compiled, {
    task: "Wait",
    input: {},
    bindings: new FixtureBindings({ tools: { poll: [false, true] } }),
    runId: "ledger-snapshot",
  });
  requireSuccess(live);

  const replaying = runTask(compiled, {
    task: "Wait",
    input: {},
    replay: live.ledger,
    runId: "ledger-snapshot",
  });
  throws(
    () => live.ledger.append("foreign-entry", { ignored_after_admission: true }),
    /terminal ledger entry/u,
  );

  const replay = await replaying;
  requireSuccess(replay);
  equal(replay.replayedEffects, 2);
  equal(
    replay.ledger.entries.some((entry) => entry.kind === "foreign-entry"),
    false,
  );
});

test("an execution exclusively owns output-ledger append ordering", async () => {
  const compiled = compileSource(repeatSource);
  const ledger = new Ledger();
  let enteredEffect!: () => void;
  let releaseEffect!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredEffect = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseEffect = resolve;
  });
  const bindings: RuntimeBindings = {
    id: "ledger-lease",
    model: {
      id: "unused",
      async complete() {
        throw new Error("model must not be called");
      },
    },
    async callTool() {
      enteredEffect();
      await release;
      return true;
    },
    async callValidator(): Promise<JsonValue> {
      throw new Error("validator must not be called");
    },
    async callVerifier() {
      throw new Error("verifier must not be called");
    },
  };

  const running = runTask(compiled, {
    task: "Wait",
    input: {},
    bindings,
    ledger,
    runId: "exclusive-ledger",
  });
  await entered;
  throws(
    () => ledger.append("branch", { site: 99 }),
    /execution owns the ledger writer/u,
  );
  throws(
    () => ledger.close(),
    /execution writer is active/u,
  );
  releaseEffect();

  const result = await running;
  requireSuccess(result);
  equal(result.ledger, ledger);
  equal(effectsFromLedger(ledger).length, 1);
  deepEqual(
    ledger.entries.map((entry) => entry.kind),
    ["run", "effect_intent", "effect", "loop", "success"],
  );
});

test("execution rejects a nonempty output ledger without mutating it", async () => {
  const occupied = new Ledger();
  occupied.append("foreign-entry", { retained: true });
  const result = await runTask(compileSource(repeatSource), {
    task: "Wait",
    input: {},
    ledger: occupied,
    runId: "occupied-ledger",
  });
  requireFailure(result);
  equal(result.error.code, "AX2144");
  notEqual(result.ledger, occupied);
  deepEqual(
    occupied.entries.map((entry) => entry.kind),
    ["foreign-entry"],
  );
});
