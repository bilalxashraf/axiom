import {
  deepEqual,
  equal,
  match,
  notEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalHash,
  canonicalJson,
  normalizeJsonValue,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import { CheckError } from "../src/errors.ts";
import { Ledger, effectsFromLedger } from "../src/ledger.ts";
import {
  createProgramLock,
  verifyProgramLock,
} from "../src/lock.ts";
import {
  assertWellFormedSchema,
  schema,
} from "../src/schema.ts";
import { runTask } from "../src/vm.ts";

const PURE_SOURCE = `
axiom 0.1;

record UnicodeResult {
  scalars: Int;
  bytes: Int;
  ordered: List<Text>;
  scalar_order: Bool;
  negative_quotient: Int;
  negative_remainder: Int;
}

task Main() -> UnicodeResult
must {}
{
  complete UnicodeResult {
    scalars: len("😀é"),
    bytes: utf8_bytes("😀é"),
    ordered: sort(["😀", ""]),
    scalar_order: "" < "😀",
    negative_quotient: -6 / 3,
    negative_remainder: -7 % 3,
  };
}
`;

function propertyCases(): number {
  const raw = process.env.AXIOM_PROPERTY_CASES;
  if (raw === undefined) {
    return 2_000;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(
      "AXIOM_PROPERTY_CASES must be an integer from 1 to 1000000",
    );
  }
  return value;
}

test("Text, Bytes, Json, and integer semantics are cross-runtime explicit", async () => {
  throws(
    () => canonicalJson("\ud800"),
    /Unicode scalar values/u,
  );
  throws(
    () => canonicalJson({ "\udc00": "invalid key" }),
    /Unicode scalar values/u,
  );
  throws(
    () => parseJson('"\\ud800"'),
    /Unicode scalar values/u,
  );
  throws(
    () => canonicalJson(1.5),
    /safe integers/u,
  );
  throws(
    () => canonicalJson(Number.MAX_SAFE_INTEGER + 1),
    /safe integers/u,
  );
  throws(
    () => assertWellFormedSchema(schema.number({ minimum: 0.5 })),
    /minimum must be a safe integer/u,
  );
  throws(
    () =>
      parseJson(
        `${"[".repeat(258)}0${"]".repeat(258)}`,
      ),
    /nesting exceeds 256/u,
  );
  equal(Object.is(parseJson("-0"), -0), false);
  equal(Object.is(normalizeJsonValue(-0), -0), false);

  // Axiom intentionally performs no Unicode normalization.
  notEqual(canonicalHash("é"), canonicalHash("e\u0301"));

  const result = await runTask(compileSource(PURE_SOURCE), {
    task: "Main",
    input: {},
    runId: "unicode-semantics",
  });
  equal(result.status, "success");
  if (result.status === "success") {
    deepEqual(result.value, {
      scalars: 3,
      bytes: 7,
      ordered: ["", "😀"],
      scalar_order: true,
      negative_quotient: -2,
      negative_remainder: -1,
    });
  }

  const bytesProgram = compileSource(`
axiom 0.1;
task Echo(value: Bytes) -> Bytes must {} {
  complete value;
}
`);
  const canonicalBytes = await runTask(bytesProgram, {
    task: "Echo",
    input: { value: "AA==" },
    runId: "canonical-bytes",
  });
  equal(canonicalBytes.status, "success");
  const noncanonicalBytes = await runTask(bytesProgram, {
    task: "Echo",
    input: { value: "AB==" },
    runId: "noncanonical-bytes",
  });
  equal(noncanonicalBytes.status, "failed");

  const inexactDivision = await runTask(
    compileSource(`
axiom 0.1;
task Divide() -> Int must {} {
  complete 7 / 3;
}
`),
    { task: "Divide", input: {}, runId: "inexact-division" },
  );
  equal(inexactDivision.status, "failed");
  if (inexactDivision.status === "failed") {
    equal(inexactDivision.error.code, "AX2005");
  }
});

test("semantic hashes ignore authoring trivia while artifact hashes bind it", () => {
  const compact = `axiom 0.1;
task Main(value: Text) -> Text must {} {
  complete value;
}
`;
  const formatted = `axiom 0.1;

// A comment is provenance, not executable semantics.
task Main(
  value: Text
) -> Text
must {
}
{
  complete value; // same operation
}
`;
  const first = compileSource(compact, "one.ax");
  const second = compileSource(formatted, "two.ax");
  equal(first.hash, second.hash);
  notEqual(first.artifactHash, second.artifactHash);
  notEqual(first.program.sourceHash, second.program.sourceHash);

  const baseline = {
    hash: first.hash,
    artifactHash: first.artifactHash,
    bytes: Buffer.from(first.bytes).toString("hex"),
  };
  for (let iteration = 0; iteration < 250; iteration += 1) {
    const compiled = compileSource(compact, `iteration-${iteration}.ax`);
    deepEqual(
      {
        hash: compiled.hash,
        artifactHash: compiled.artifactHash,
        bytes: Buffer.from(compiled.bytes).toString("hex"),
      },
      baseline,
    );
  }
});

test("AXLOCK freezes capabilities, static bounds, artifact, and host binding", () => {
  const compiled = compileSource(PURE_SOURCE);
  const binding = {
    id: "production-bindings",
    fingerprint:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
  };
  const lock = createProgramLock(compiled, binding);
  equal(lock.tasks.length, 1);
  deepEqual(lock.tasks[0], {
    name: "Main",
    ports: [],
    operation_bound: 1,
    effect_bound: 0,
    model_attempt_bound: 0,
    write_bound: 0,
    task_hash: lock.tasks[0]?.task_hash,
  });
  verifyProgramLock(structuredClone(lock), compiled, binding);
  throws(
    () =>
      createProgramLock(compiled, {
        ...binding,
        id: "\ud800",
      }),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1602");
      return true;
    },
  );

  const changed = structuredClone(lock) as {
    program: { artifact_hash: string };
  };
  changed.program.artifact_hash =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  throws(
    () => verifyProgramLock(changed, compiled, binding),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1605");
      match(error.message, /artifact hash differs/u);
      return true;
    },
  );
});

test("seeded canonicalization properties are stable and idempotent", () => {
  let state = 0x4158494f;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const scalarStrings = [
    "",
    "ascii",
    "é",
    "e\u0301",
    "😀",
    "",
    "𐀀",
  ];
  const value = (depth: number): JsonValue => {
    const choice = next() % (depth === 0 ? 4 : 7);
    switch (choice) {
      case 0:
        return null;
      case 1:
        return (next() & 1) === 0;
      case 2:
        return (next() % 2_000_001) - 1_000_000;
      case 3:
        return scalarStrings[next() % scalarStrings.length] as string;
      case 4:
        return [value(depth - 1), value(depth - 1)];
      default: {
        const left = value(depth - 1);
        const right = value(depth - 1);
        return (next() & 1) === 0
          ? { alpha: left, "😀": right }
          : { "😀": right, alpha: left };
      }
    }
  };

  for (let iteration = 0; iteration < propertyCases(); iteration += 1) {
    const candidate = value(3);
    const encoded = canonicalJson(candidate);
    equal(canonicalJson(parseJson(encoded, { requireCanonical: true })), encoded);
  }

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const first = value(2);
    const second = value(2);
    const left: JsonObject = { alpha: first, "😀": second };
    const right: JsonObject = { "😀": second, alpha: first };
    equal(canonicalJson(left), canonicalJson(right));
  }
});

test("durable ledgers are canonical, bounded, and replay-structured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
  const path = join(directory, "run.axlog");
  const ledger = Ledger.createDurable(path);
  ledger.append("run", { run_id: "durable" });
  ledger.append("failure", { code: "EXPECTED" });
  const exposed = ledger.entries;
  equal(Object.isFrozen(exposed), true);
  equal(Object.isFrozen(exposed[0]), true);
  equal(Object.isFrozen(exposed[0]?.payload), true);
  const root = ledger.root;
  ledger.close();

  const loaded = await Ledger.read(path);
  equal(loaded.root, root);
  deepEqual(
    loaded.entries.map((entry) => entry.kind),
    ["run", "failure"],
  );
  deepEqual(effectsFromLedger(loaded), []);

  const canonical = await readFile(path, "utf8");
  await writeFile(path, canonical.replace(/\n$/u, ""), "utf8");
  await rejects(
    () => Ledger.read(path),
    /must end with one newline/u,
  );
});
