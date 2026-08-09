import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJson,
  compileSource,
  createProgramLock,
  FixtureBindings,
  runTask,
} from "../dist/src/index.js";

const source = [
  "axiom 0.2;",
  "",
  "extern tool chosen(label: Text) -> Unit mode read;",
  "extern tool poll() -> Bool mode read;",
  "",
  "task Main(flag: Bool) -> Unit",
  "must {}",
  "{",
  "  if flag then {",
  '    observe selected_true = chosen("then");',
  "  } else {",
  '    observe selected_false = chosen("else");',
  "  }",
  "  repeat max 3 {",
  "    observe done = poll();",
  "  } until done;",
  "  complete unit;",
  "}",
  "",
].join("\n");

const compiled = compileSource(source, "control-002.ax");

async function execute(flag) {
  const execution = await runTask(compiled, {
    task: "Main",
    input: { flag },
    bindings: new FixtureBindings({
      tools: {
        chosen: [null],
        poll: [false, true],
      },
    }),
    runId: flag ? "control-true-002" : "control-false-002",
  });
  if (execution.status !== "success") {
    throw new Error(`Control vector failed: ${execution.error.message}`);
  }
  return {
    input: { flag },
    run_id: execution.runId,
    value: execution.value,
    ledger_entries: execution.ledger.entries,
    ledger_root: execution.ledger.root,
  };
}

function rejection(name, rejectedSource) {
  try {
    compileSource(rejectedSource, `${name}.ax`);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      return { name, code: error.code };
    }
    throw error;
  }
  throw new Error(`Negative control vector ${name} unexpectedly compiled`);
}

const vectors = {
  format: "AXIOM-CONTROL-FLOW-CONFORMANCE/0.2",
  frozen: true,
  versions: {
    package: "@axiom-lang/core@0.3.0",
    language: "0.2",
    air: "AIR/0.2",
    axlock: "AXLOCK/0.2",
    axlog: "AXLOG/0.2",
  },
  program: {
    source_name: "control-002.ax",
    source,
    semantic_hash: compiled.hash,
    artifact_hash: compiled.artifactHash,
    canonical_air: canonicalJson(compiled.program),
    canonical_air_utf8_bytes: compiled.bytes.byteLength,
    lock: createProgramLock(compiled),
  },
  executions: [await execute(true), await execute(false)],
  rejected: [
    rejection(
      "core-01-if",
      "axiom 0.1; task Main(flag: Bool) -> Unit must {} { if flag then {} else {} complete unit; }",
    ),
    rejection(
      "repeat-over-policy",
      "axiom 0.2; extern tool poll() -> Bool mode read; task Main() -> Unit must {} { repeat max 1025 { observe done = poll(); } until done; complete unit; }",
    ),
    rejection(
      "repeat-constant-condition",
      "axiom 0.2; extern tool poll() -> Bool mode read; task Main() -> Unit must {} { repeat max 2 { observe done = poll(); } until true; complete unit; }",
    ),
  ],
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv[2] === "--write") {
  writeFileSync(join(process.cwd(), "spec", "control-flow-vectors.json"), text);
} else if (process.argv.length === 2) {
  process.stdout.write(text);
} else {
  throw new Error("Usage: node scripts/generate-control-flow-vectors.mjs [--write]");
}
