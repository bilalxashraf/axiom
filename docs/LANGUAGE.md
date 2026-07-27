# Axiom Core 0.1

## 1. Purpose

Axiom is a language for executing agent workflows under deterministic control.
The model is a typed external function, not the workflow interpreter.

Core 0.1 is intentionally small. It is sufficient to:

1. declare JSON-shaped data;
2. name propositions that trusted code may verify;
3. declare tool, model, validator, and verifier ports;
4. create mandatory obligations;
5. call external ports at explicit sites;
6. validate model-produced candidates;
7. attach evidence to obligations; and
8. prevent successful completion until every obligation is satisfied.

The normative concrete grammar is
[`../spec/grammar.ebnf`](../spec/grammar.ebnf).

## 2. Determinism boundary

Parsing, type checking, AIR generation, expression evaluation, obligation
tracking, canonical serialization, ledger hashing, and state transitions are
deterministic.

Only declared external ports may depend on the outside world:

| Port | Purpose | Returned trust |
| --- | --- | --- |
| `tool ... mode read` | Observe external state | Typed observation |
| `tool ... mode write` | Change external state | Typed receipt |
| `model` | Produce a judgment or artifact | `Candidate<T>` |
| `validator` | Check and narrow a candidate | Validated `T` |
| `verifier` | Establish a proposition | `Evidence<P>` |

External responses are recorded. Replay replaces those calls with ledger
responses, giving deterministic execution for the recorded run.

## 3. Program structure

Every source begins with:

```axiom
axiom 0.1;
```

Declarations follow in source order. A declaration is a source artifact,
unresolved or resolved migration disposition, source-wide review seal, record,
proposition, external port, or task.
Names occupy one module-wide namespace in Core 0.1 and must be unique where
ambiguity would result. Identifiers are ASCII letters, digits, and underscore,
must begin with a letter or underscore, and are capped at 256 characters.
String literals decode to Unicode scalar sequences; unpaired surrogate escapes
are rejected.

Comments use `//` to the end of the line or `/* ... */`.

### 3.1 Migration provenance

`source`, `unresolved`, `resolved`, and `review` are non-executable migration
declarations:

```axiom
source markdown_source path "AGENTS.md"
  hash "sha256:0123..." bytes 482 base64 "IyBSdWxlcy4uLg=="
  map "AGENTS.axmap.json";

unresolved md_000003 source markdown_source bytes 31 58
  hash "sha256:4567..." category "list"
  reason "Imported Markdown list may carry instructions; semantics are unresolved.";

resolved span_000003 source markdown_source bytes 31 58
  hash "sha256:4567..." as requirement
  task Fix obligation inspected reason "Reviewed and linked to the inspection obligation.";

review markdown_source
  source_hash "sha256:0123..."
  dispositions_hash "sha256:89ab...";
```

A source embeds the exact bytes as canonical base64 and records their content
hash, exact byte length, and coverage-sidecar path. The compiler decodes the
payload, checks its length and hash, independently derives the Markdown byte
partition, and requires the matching unresolved IDs, ranges, hashes, and
categories. Deleting or altering an unresolved line therefore fails coverage
checking. On every CLI path that loads `.ax`, the named `AXMAP/0.1` sidecar is
also mandatory, strictly validated, and cryptographically matched to the
`source` declaration. `--map` may add an explicit sidecar anchor; it does not
make the declaration's named sidecar optional.
An unresolved declaration identifies one non-empty, in-bounds byte range in
that source. Its hash binds the declaration to the range recorded in the
sidecar.

Strict compilation rejects every remaining `unresolved` declaration with
`AX1000`. These nodes exist so migration tooling cannot hide uncertain prose
in comments or silently treat it as documentation.

A reviewer removes the corresponding `unresolved` declaration and records
exactly one explicit disposition using the compiler-derived span ID from the
coverage map:

```axiom
resolved ID source SRC bytes START END hash "sha256:SPAN_HASH" as requirement
  task TASK obligation OBL reason "Why this formal obligation captures the span.";

resolved ID source SRC bytes START END hash "sha256:SPAN_HASH" as non_normative
  reason "Why this span does not constrain execution.";

review SRC source_hash "sha256:SOURCE_HASH"
  dispositions_hash "sha256:CANONICAL_DISPOSITIONS_HASH";
```

A `requirement` disposition must name an existing obligation on an existing
task. A `non_normative` disposition must carry a nonempty review reason. The
compiler rejects missing dispositions, dual unresolved/resolved dispositions,
unknown source or span IDs, stale byte-range/hash bindings, and invalid
task-obligation links. The range and hash bind the decision to the exact source
span.

After all nonblank spans are dispositioned, exactly one `review` seal is
required for the source. Its `source_hash` must equal the exact imported
document hash. Its `dispositions_hash` is the compiler-recomputed
`AXREVIEW-DISPOSITIONS/0.2` canonical digest of every resolution ID, byte
anchor, span hash, disposition, link, linked proposition name and mode, reason,
and `AXREVIEW-FORMAL/0.1` hash of all executable formal declarations. Thus a
contextual edit anywhere in the document, a change to a disposition, or a
change to task, verifier, validator, port, record, or proposition semantics
behind the same names requires an explicit source-wide re-attestation. The
compiler reports the expected seal after the per-span checks pass. A
whitespace-only source needs no seal, but any seal supplied for it is checked
against the source and canonical empty set. Resolution and seal metadata are
then omitted from executable AIR and every model frame.

This mechanism requires an explicit review decision; it does not prove that a
review occurred honestly or that an obligation is semantically equivalent to
arbitrary prose. Those judgments remain in the trusted authoring process;
deployments can protect seal changes with code ownership or signatures.

## 4. Values and types

### 4.1 Built-in types

- `Text`: a finite sequence of Unicode scalar values. Unpaired UTF-16
  surrogates are invalid at every source, AIR, JSON, protocol, and ledger
  boundary. Equality is exact; Axiom performs no implicit Unicode
  normalization.
- `Int`: an integer from `-(2^53 - 1)` through `2^53 - 1`.
- `Bool`: `true` or `false`.
- `Bytes`: an opaque byte payload represented by canonical padded RFC 4648
  base64. Alternate padding or nonzero unused bits are rejected.
- `Json`: `null`, Boolean, `Text`, safe integer, finite list, or finite
  string-keyed object in Axiom's canonical JSON domain. Fractional and unsafe
  numeric values are not in this domain.
- `Unit`: the singleton value `unit`, encoded as JSON `null`.
- `List<T>`: an ordered finite list.
- `Candidate<T>`: untrusted model output shaped like `T`.
- `Evidence<P>`: verifier-issued evidence for proposition `P`.

User-defined records are JSON objects with exactly their declared fields:

```axiom
record Plan {
  file: Text;
  patch: Text;
}
```

Record values normally name their type:

```axiom
Plan {
  file: "src/main.ts",
  patch: "...",
}
```

The type name may be omitted where the surrounding expression supplies one
unambiguously, such as a typed port argument or task result.

Arrays are homogeneous:

```axiom
["parser", "lexer"]
```

Core 0.1 has no implicit conversions. In particular, a `Candidate<Plan>` is not
a `Plan`.

### 4.2 Expressions

Expressions include literals, variables, field access, arrays, record
construction, deterministic built-ins, and binary operators.

Deterministic built-ins are:

- `len(value)`
- `utf8_bytes(text)`
- `contains(container, value)`
- `sort(list)`
- `hash(value)`
- `min(first, ...)`
- `max(first, ...)`

Binary operators, from lowest to highest precedence, are:

```text
||  &&  == !=  < <= > >=  + -  * / %
```

Unary `!`, `+`, and `-` bind more tightly. `&&` and `||` short-circuit.
Equality is structural canonical equality. `len(Text)` counts Unicode scalar
values, not UTF-16 code units or grapheme clusters. `utf8_bytes(Text)` returns
the exact UTF-8 byte count. Text ordering and `sort(List<Text>)` are
lexicographic by Unicode scalar value.

Arithmetic is checked and accepts safe integers only. Overflow fails. Division
by zero fails, and `/` also fails unless the mathematical quotient is an exact
safe integer. Remainder is defined as
`a % b = a - trunc(a / b) * b`, so a nonzero result has the dividend's sign;
remainder by zero fails.

## 5. Propositions and evidence

A proposition names a claim:

```axiom
proposition Inspected event;
proposition TestsPass state;
```

`event` describes something that occurred during the run. `state` describes a
condition that holds for the current external state. A write `act` invalidates
every previously satisfied `state` obligation, which must then be verified and
satisfied again. Satisfied `event` obligations survive later writes. More
precise effect-specific invalidation is reserved for a later version.

Only a declared verifier can produce evidence:

```axiom
extern verifier exit_zero(result: TestResult) proves TestsPass;
```

The call:

```axiom
verify test_evidence = exit_zero(test_result);
```

binds `test_evidence` as `Evidence<TestsPass>`. Evidence is nominal: evidence
for one proposition cannot satisfy an obligation for another.

## 6. External ports

### 6.1 Tools

```axiom
extern tool inspect(issue: Issue) -> Facts mode read;
extern tool apply(plan: Plan) -> Receipt mode write;
```

Read tools are called with `observe`. Write tools are called with `act`.
An `act` requires an idempotency-key expression:

```axiom
observe facts = inspect(issue);
act receipt = apply(plan) key hash(plan);
```

The runtime passes the evaluated key to the host. A conforming host must treat
repeated calls with the same program, site, and key as the same logical effect.
The key does not make a non-idempotent host safe by magic; the adapter must
implement deduplication.

### 6.2 Models

```axiom
extern model planner(input: PlannerInput) -> Plan
  intent "Choose one relevant file and propose the smallest patch.";
```

The declared return is `Plan`, but `infer` always binds
`Candidate<Plan>`. Every inference has portable byte and attempt limits:

```axiom
infer raw_plan = planner(input)
  limit input_bytes 16384 output_bytes 4096 attempts 2;
```

The model receives the port intent and a node-local protocol frame. It does not
execute the task body. Each live attempt also has a host liveness deadline:
30 seconds by default, configurable through `RunOptions.inferenceTimeoutMs` or
the CLI's `--inference-timeout-ms`. Replay performs no live inference and does
not consume that deadline. An intent must contain 1–1024 Unicode scalar values
so every compiled model operation fits AXIP's bounded text fields.

### 6.3 Validators

```axiom
extern validator safe_plan(
  raw: Candidate<Plan>,
  facts: Facts
) -> Plan;
```

Validators are trusted host code. `validate` is the only operation that may
narrow a `Candidate<T>` into a value that effectful ports can consume:

```axiom
validate plan = safe_plan(raw_plan, facts);
```

Schema parsing alone is not necessarily sufficient validation. A validator may
also enforce paths, capabilities, grounding, size, policy, or domain rules.

### 6.4 Verifiers

Verifiers are trusted host code associated with exactly one proposition:

```axiom
extern verifier changed(receipt: Receipt) proves Applied;
```

A verifier either returns valid proposition-bound evidence or fails. Models and
tools cannot mint evidence merely by returning an object that resembles it.

## 7. Tasks and linear obligations

A task declares inputs, a result, and its mandatory obligations:

```axiom
task Fix(issue: Issue) -> FixResult
must {
  inspected: Inspected;
  applied: Applied;
  tests: TestsPass;
}
{
  // operations
}
```

At task entry, each `must` item becomes a pending obligation identified by its
name. The identifiers must be unique within the task.

The only Core 0.1 operation that resolves an obligation is:

```axiom
satisfy tests with test_evidence;
```

This is valid only when `test_evidence` has the exact
`Evidence<TestsPass>` type required by `tests`. An obligation cannot be
satisfied twice, evidence cannot be fabricated, and there is no `skip`
operation.

`complete value;` is legal only when:

- `value` has the task's declared return type; and
- every task obligation is satisfied on that execution path.

Otherwise checking or execution fails. `fail "reason";` terminates without
success and therefore does not violate the completion guarantee.

## 8. Operations

Core 0.1 operations are:

```axiom
observe name = read_tool(arguments);
infer name = model(arguments)
  limit input_bytes N output_bytes N attempts N;
validate name = validator(arguments);
act name = write_tool(arguments) key expression;
verify name = verifier(arguments);
satisfy obligation with evidence;
assert condition;
complete expression;
fail "message";
```

The task header `must` block is the only Core 0.1 obligation declaration.
Bindings are immutable and operations execute in source order. `assert`
terminates unsuccessfully when its Boolean expression is false. `fail` requires
a literal text reason. Core 0.1 deliberately has no branch, loop, recursion,
dynamic task generation, exception handling, concurrency, or unrestricted
`eval`; those features would complicate termination and obligation accounting.

## 9. Static checks

A conforming checker rejects at least:

- duplicate declarations or bindings;
- unknown names, types, ports, obligations, or fields;
- wrong argument counts or types;
- `observe` on a write tool;
- `act` on a read tool;
- `infer` on a non-model port;
- `validate` on a non-validator port;
- `verify` on a non-verifier port;
- use of `Candidate<T>` where `T` is required;
- evidence/proposition mismatch;
- missing or non-positive inference limits;
- completion with unresolved obligations;
- a task body with no terminal `complete` or `fail`;
- statements after terminal `complete` or `fail`;
- optional record fields or optional types;
- parameterized propositions;
- an unresolved imported source span; and
- malformed or out-of-bounds migration provenance.

Source locations are retained for diagnostics. Successful compilation produces
canonical `AIR/0.1` with two hashes:

- a domain-separated semantic hash over executable declarations, excluding
  `sourceHash`; and
- an artifact hash over the exact canonical AIR, including source provenance.

Comments and formatting can change the artifact hash without changing effect
identity or replay compatibility.

Canonical bytes are not accepted as a substitute for semantic checking. The
strict AIR verifier checks exact object shapes, declaration and field
uniqueness, type and port consistency, immutable bindings, contiguous operation
sites, terminal control flow, and obligation/evidence transitions. The
compiler verifies its own output, the CLI verifies loaded `.air` files, and the
VM verifies AIR again before execution.

## 10. Runtime states

Within a running Core 0.1 task, each obligation is in exactly one state:

```text
pending -> satisfied
satisfied(state) -> stale (after a write act)
stale -> satisfied (with fresh evidence)
```

There is no `skipped` state. A task either reaches `complete` with all
obligations satisfied or terminates unsuccessfully. A later
conditional-obligation feature may add `inapplicable`, but only with recorded
proof that its declared guard was false. A model response saying “done” has no
special meaning.

## 11. AIR and replay

Compilation lowers source to an `AIR/0.1` program containing normalized types,
ports, tasks, operation sites, and obligation identities. Canonical JSON
serialization sorts object keys by Unicode scalar value and rejects
fractional/unsafe numbers, unpaired surrogates, excessive nesting, sparse
arrays, accessors, custom prototypes, cycles, and values whose meaning JSON
would silently change. This is the normative Axiom canonical profile, not a
claim of byte identity with RFC 8785 JCS. JSON parsing also rejects duplicate
object keys by default; later-key-wins parsing is not accepted at protocol,
AIR, input, or ledger boundaries.

With a durable ledger, every external request is written and flushed as an
`effect_intent` before dispatch; its success or failure is then written as an
`effect` outcome. An unmatched intent is an uncertain effect and cannot be
replayed as success. The run header is written before the first effect and
records `trusted_bindings` with the binding-set ID,
optional lowercase SHA-256 implementation fingerprint, and model-adapter ID.
Production hosts should fingerprint the exact trusted tool, validator, and
verifier package; a missing fingerprint is recorded as `null`, not silently
treated as an attestation. Replay preserves the recorded provenance, checks the
ledger chain and strict entry shapes, matches each intent and recorded request
to the current effect site, supplies the recorded response, and verifies the
obligation-transition and terminal transcript.

Therefore:

```text
same semantic program + same task input + same effective policy
+ same recorded effects
=> same Axiom state transitions and result
```

This is replay determinism, not a claim that two live model calls are identical.

## 12. Markdown migration

Markdown import is not part of the Core 0.1 executable, but the language is
designed as its target. The lossless importer assigns every source span a
stable identifier. Blank spans remain retained provenance. Every nonblank span
starts as an unresolved hole that prevents strict compilation and must later be
reviewed as either:

- a `requirement` linked to a declared task obligation; or
- `non_normative` with a recorded reason.

One source-wide review seal then binds those decisions to the exact source
version, complete canonical disposition set, and a hash of all executable
formal records, propositions, ports, verifiers, validators, and task
operations. Keeping names unchanged while altering formal behavior therefore
invalidates the seal. Per-span hashes diagnose local edits; the seal prevents
unchanged lines from silently retaining a disposition after surrounding or
formal context changes.

The importer's required coverage rule is:

```text
Every normative source span has a mapped Axiom node or a visible diagnostic.
```

An LLM may propose the mapping, but it must not silently decide that a sentence
is non-normative. A human or trusted review process must inspect the original
span and formal program before recording the disposition. Coverage and seal
checking can prove that nothing disappeared, requirement links are well
formed, and the attestation is not stale; they cannot prove semantic
equivalence between natural language and Axiom or honest review.
Human-authored Axiom can be authoritative immediately; generated Markdown can
remain as a readable projection.

## 13. Honest guarantee

For a program accepted by a conforming checker and runtime:

```text
Run(program, input) = Complete(value)
implies
every declared task obligation was satisfied by matching verifier evidence.
```

Core 0.1 does not guarantee that:

- a natural-language requirement was formalized correctly;
- a reviewed Markdown resolution is semantically equivalent to its prose;
- a model will return a useful or schema-valid candidate;
- a tool, validator, or verifier implementation is honest;
- an external effect succeeds;
- live executions have identical external responses;
- a timeout cancels a remote write that ignores its abort signal;
- a hash chain is authentic without a separately trusted root or signature; or
- subjective goals are objectively true.

Those uncertainties are made explicit and auditable instead of being hidden in
a general-purpose prompt.
