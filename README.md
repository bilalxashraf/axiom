# Axiom

Axiom is an experimental, proof-carrying execution language for AI agents.
Humans or agents write `.ax` programs; a deterministic runtime owns control
flow, effects, obligations, and completion. Models are called only at explicit
`infer` sites and return untrusted `Candidate<T>` values.

The `@axiom-lang/core` 0.2 toolchain implements the deliberately small Axiom
Core 0.1 language and AIR/0.1. It is an alpha suitable for evaluation and
conformance work, not a claim that arbitrary live model output is
deterministic or that production sandboxes are no longer necessary.

The central guarantee of the certified core is:

> A task cannot complete successfully while one of its declared obligations is
> unresolved.

This is narrower—and more useful—than claiming that a model always understands
prose or that every task will succeed. Axiom can prevent silent omission of a
formal instruction. It cannot make an impossible instruction possible, prove a
subjective claim without a verifier, or force different models to produce the
same candidate.

## A small program

```axiom
axiom 0.1;

record Issue {
  summary: Text;
  terms: List<Text>;
}

record Facts {
  files: List<Text>;
}

record PlannerInput {
  issue: Issue;
  facts: Facts;
}

record Plan {
  file: Text;
  patch: Text;
}

record Receipt {
  changed: Bool;
}

record TestResult {
  exit_code: Int;
}

record FixResult {
  receipt: Receipt;
}

proposition Inspected event;
proposition Applied event;
proposition TestsPass state;

extern tool inspect(issue: Issue) -> Facts mode read;
extern tool apply(plan: Plan) -> Receipt mode write;
extern tool test(input: Unit) -> TestResult mode read;

extern model planner(input: PlannerInput) -> Plan
  intent "Choose one relevant file and propose the smallest patch.";

extern validator safe_plan(raw: Candidate<Plan>, facts: Facts) -> Plan;

extern verifier nonempty(facts: Facts) proves Inspected;
extern verifier changed(receipt: Receipt) proves Applied;
extern verifier exit_zero(result: TestResult) proves TestsPass;

task Fix(issue: Issue) -> FixResult
must {
  inspected: Inspected;
  applied: Applied;
  tests: TestsPass;
}
{
  observe facts = inspect(issue);
  verify inspection_evidence = nonempty(facts);
  satisfy inspected with inspection_evidence;

  infer raw_plan = planner(PlannerInput {
    issue: issue,
    facts: facts,
  }) limit input_bytes 16384 output_bytes 4096 attempts 2;

  validate plan = safe_plan(raw_plan, facts);
  act receipt = apply(plan) key hash(plan);

  verify applied_evidence = changed(receipt);
  satisfy applied with applied_evidence;

  observe test_result = test(unit);
  verify test_evidence = exit_zero(test_result);
  satisfy tests with test_evidence;

  complete FixResult { receipt: receipt };
}
```

`planner` may be backed by any model adapter. It does not receive permission to
call tools, satisfy obligations, or complete the task. `safe_plan` must turn its
candidate into a validated `Plan` before `apply` can consume it.

See [`examples/fix.ax`](examples/fix.ax) for the complete runnable example.

## Try the prototype

Axiom currently requires Node.js 24 or newer.

```sh
npm install
npm run build
npm test
```

The CLI workflow is shown below. In a local checkout, either put the package
binary on `PATH` with `npm link` or replace `axiom` with
`node dist/src/cli.js`.

```sh
axiom import-md AGENTS.md -o AGENTS.ax
axiom conform --adapter-url http://127.0.0.1:8080
axiom check examples/fix.ax
axiom compile examples/fix.ax -o fix.air
axiom lock examples/fix.ax -o axiom.lock \
  --fixtures examples/fixtures.json
axiom verify-lock examples/fix.ax --lock axiom.lock \
  --fixtures examples/fixtures.json
axiom run examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --fixtures examples/fixtures.json \
  --lock axiom.lock \
  --ledger run.axlog
axiom replay examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --ledger run.axlog
axiom frame examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --fixtures examples/fixtures.json
```

`import-md` is deliberately conservative: it preserves the exact Markdown
bytes in an `AXMAP/0.1` sidecar and emits an explicit `unresolved` declaration
for every nonblank span. The draft parses, but strict compilation fails until
those spans are formally resolved; the importer never guesses that prose is
merely documentation. A reviewer replaces each unresolved disposition with
one of:

```axiom
resolved span_000001 source markdown_source bytes 0 17
  hash "sha256:0123..." as requirement
  task Fix obligation inspected reason "Reviewed as the inspection requirement.";

resolved span_000002 source markdown_source bytes 17 61
  hash "sha256:4567..." as non_normative
  reason "Example text; it does not constrain execution.";

review markdown_source
  source_hash "sha256:SOURCE_HASH"
  dispositions_hash "sha256:CANONICAL_DISPOSITIONS_HASH";
```

The first form must name an existing task obligation. The second requires an
explicit reason for treating the span as non-normative. After all spans are
dispositioned, one source-wide `review` seal binds the exact document hash and
the compiler-derived hash of every disposition. The checker reports the exact
seal expected after review. Per-span anchors catch edits and moves precisely;
the source-wide seal also invalidates unchanged lines when surrounding context
changes. This proves visible, content-bound coverage, not that an obligation is
semantically equivalent to prose or that a reviewer was honest. CLI commands
that load the `.ax` file require and validate its named `AXMAP/0.1` sidecar;
`--map path` may supply an additional explicit anchor. See
[`docs/MARKDOWN-IMPORT.md`](docs/MARKDOWN-IMPORT.md).

`check` rejects malformed programs, type errors, invalid port use, and
completion paths with unresolved obligations. `compile` emits canonical
`AIR/0.1`; a strict AIR verifier independently re-establishes the safety
invariants before loaded or externally supplied AIR may run. `lock` emits
canonical `AXLOCK/0.1`, freezing the toolchain profile, semantic and artifact
hashes, exact port signatures, inferred least-authority port sets, static
operation/effect/model-attempt/write bounds, and an optional trusted binding
fingerprint. `verify-lock` compares the whole lock fail-closed.
`run --lock` and `frame --lock` perform that same whole-object check against
the actual runtime binding fingerprint before any effect or model frame is
dispatched. There is no implicit lock search: omitting `--lock` is an explicit
unlocked alpha-mode execution.

`run --ledger path` creates a new append-only, fsynced write-ahead ledger.
Every external call records `effect_intent` before dispatch and its outcome
afterward; an intent without an outcome is explicitly uncertain rather than
silently replayable. Every caught write failure is also marked
`uncertain: true` for reconciliation. The ledger includes the trusted
binding-set ID, optional SHA-256 fingerprint, and model-adapter ID.
`replay` substitutes recorded effect responses and checks that execution
reaches the same obligation transcript and terminal result without live
calls. A ledger hash chain detects mutation relative to a trusted root; it is
not a signature, MAC, or transparency log by itself. `frame` runs against
fixtures and prints the compact AXIP model frame for inspection.

Each live model attempt and each tool, validator, or verifier call has a
30-second host deadline by default. Use
`--inference-timeout-ms N` on `run` or `frame` to choose another positive
model deadline and `--effect-timeout-ms N` for other effects. Bindings receive
an abort signal; a timed-out external write remains marked uncertain because
the remote system may ignore cancellation. For an HTTP endpoint that has
already installed the exact AXIP prologue hash, `--cached-prologue` lets the
runtime send the referenced prologue form; otherwise it safely sends the
inline prologue.

## Why this is more deterministic than Markdown

Markdown asks a model to continually reinterpret a mixture of prose, examples,
preferences, and rules. Axiom separates those roles:

- `must` creates a named, linear obligation.
- `observe` calls a read-only tool.
- `infer` is the explicit nondeterministic boundary.
- `validate` converts an untrusted candidate into a usable value.
- `act` performs an idempotency-keyed write.
- `verify` asks trusted code for proposition-specific evidence.
- `satisfy` consumes matching evidence and resolves one obligation.
- `complete` succeeds only when no obligation remains.

The same executable semantics compile to the same domain-separated semantic
hash. Comments and formatting alter the source-provenance and AIR artifact
hashes, but not effect identity or replay compatibility. Given the same
semantic program, typed input, effective policy, and recorded external
responses, replay follows the same checked state transitions and terminal
result.

This does **not** mean that two live model calls—or two different models—return
the same candidate. Axiom makes control, authority, validation, evidence,
failure, and replay deterministic around that explicitly nondeterministic
boundary. The VM is a standardized harness generated from the language; it
does not make a runtime, adapter, durable store, or host sandbox disappear.

## Token efficiency

Axiom source is for authors, not a prompt copied into every model call. The
runtime compiles it once and sends a model only the current node-local frame:
the inference intent, typed input, output schema, active obligation identifiers,
and referenced context needed at that site.

The protocol is designed around:

- UTF-8 byte budgets, which work without knowing a provider's tokenizer;
- compact schemas and content-addressed context references;
- a cacheable prologue identified by hash, selected automatically when an
  adapter advertises that exact cached reference;
- compact canonical wire keys at the adapter boundary;
- node-local inputs, so task source and earlier conversation are not sent;
- schema pruning, so unrelated record definitions consume no model tokens;
- per-site attempt and output limits.

Token counts remain useful telemetry, but bytes are the portable enforcement
unit because providers tokenize differently. See
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) and
[`docs/TOKEN-EFFICIENCY.md`](docs/TOKEN-EFFICIENCY.md).

## Model independence

Language semantics do not depend on a model vendor, prompt template, native
tool-calling format, or tokenizer. A provider adapter translates a normalized
Axiom inference frame to a provider request and translates its response back to
one of three outcomes: `candidate`, `need_context`, or `fail`.

“Model-independent” does not mean “all models are equally capable.” It means
that changing the model cannot alter the program's obligations, available
ports, tool modes, validators, verifiers, or completion rule. A model that
cannot produce the declared schema within budget fails that inference; it does
not get to bypass the type system. See
[`docs/MODEL-INDEPENDENCE.md`](docs/MODEL-INDEPENDENCE.md).

The library exports `checkAdapterConformance(adapter)`, a bounded AXIP probe
that checks strict framing, typed output, identity echoing, budgets, and exact
nonce preservation. It is a compatibility check, not a model-quality
benchmark. Direct AXIP HTTP endpoints can run it with
`axiom conform --adapter-url <url>`.

## Files and status

- [`docs/LANGUAGE.md`](docs/LANGUAGE.md) defines Axiom Core 0.1.
- [`spec/grammar.ebnf`](spec/grammar.ebnf) gives its concrete grammar.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) defines the model boundary.
- [`docs/MARKDOWN-IMPORT.md`](docs/MARKDOWN-IMPORT.md) defines lossless,
  fail-closed Markdown migration.
- [`docs/DESIGN-SYNTHESIS.md`](docs/DESIGN-SYNTHESIS.md) records what Axiom
  takes from—and rejects from—Go, Rust, Java, Kotlin, C++, Starlark, CUE, and
  Rego.
- [`docs/GUARANTEES.md`](docs/GUARANTEES.md) states the exact determinism
  boundary.
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) lists trust assumptions and
  residual risks.
- [`docs/DYNAMIC-HARNESSES.md`](docs/DYNAMIC-HARNESSES.md) specifies the
  bounded, verified task-graph direction.
- [`docs/LOCKFILES.md`](docs/LOCKFILES.md),
  [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), and
  [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) cover reproducibility and
  ecosystem contracts.
- [`spec/conformance-vectors.json`](spec/conformance-vectors.json) freezes
  exact cross-runtime canonical data, AIR, AXLOCK, AXLOG, and AXIP outputs.
- [`docs/LAUNCH.md`](docs/LAUNCH.md) is the research-preview release and
  claims checklist.
- [`examples/`](examples) contains a program, input, and deterministic fixtures.

This is a 0.2 alpha toolchain, not yet a security sandbox or an AGI mechanism.
External ports are trusted host integrations and must enforce their own
operating-system, network, secret, approval, and monetary permissions. The
Markdown importer emits review-required drafts, not automatic semantic
translations. Content-bound dispositions now bind to the complete formal
semantics, but the review judgment itself remains a human or trusted-process
responsibility.

Scoped unforgeable capabilities, algebraic `Result`/`Option`, exhaustive
matching, effect regions, content-addressed dependency imports, transactions,
an independent verifier implementation, and bounded dynamic task graphs remain
required before a production 1.0 claim. See the threat model and roadmap rather
than treating “uses Axiom” as a substitute for deployment security.
