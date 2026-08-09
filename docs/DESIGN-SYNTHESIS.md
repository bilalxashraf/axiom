# Axiom design synthesis

Status: non-normative design rationale and roadmap
Implementation snapshot: `@axiom-lang/core` 0.3.0, Axiom source 0.1 and 0.2,
`AIR/0.1` and `AIR/0.2`, `AXIP/1`, `AXLOCK/0.1` and `AXLOCK/0.2`

The normative Core language is defined in [`LANGUAGE.md`](LANGUAGE.md), the
frozen [`../spec/grammar.ebnf`](../spec/grammar.ebnf), and the Core 0.2
[`../spec/grammar-0.2.ebnf`](../spec/grammar-0.2.ebnf) and
[`../spec/semantics-0.2.md`](../spec/semantics-0.2.md).
This document explains why Axiom has its current shape, which ideas it takes
from established languages, which ideas it deliberately rejects, and which
features remain proposals rather than implemented syntax.

## 1. The actual objective

Axiom is not an attempt to make a probabilistic model itself deterministic.
It is an attempt to make the system around that model:

- formally specified instead of repeatedly reinterpreted from prose;
- explicit about where nondeterminism enters;
- unable to report success while declared obligations remain unresolved;
- least-authority at every external effect;
- reproducible from recorded external outcomes; and
- portable across model vendors and tokenizers.

The strongest useful Core guarantee is:

> A valid Axiom task cannot complete successfully while any of its declared
> obligations is unresolved.

That is a safety property. It is not a guarantee that the task succeeds, that
the model proposes a good answer, that a tool tells the truth, or that a human
translated prose correctly. When an instruction is impossible, a verifier
rejects it, a model exhausts its attempts, or a required tool is unavailable,
the correct deterministic behavior is a visible failure—not fabricated
success.

### 1.1 What “does not skip instructions” can mean

There are four different claims that are often compressed into that phrase:

1. **Source coverage:** no potentially normative source span silently
   disappears during migration.
2. **Formal coverage:** every accepted requirement is linked to an executable
   obligation.
3. **Runtime coverage:** successful completion requires every obligation to
   have matching, current verifier evidence.
4. **Real-world success:** every requested action actually becomes possible and
   achieves the author's intended result.

Axiom can enforce the first three within its trust boundary. No language can
guarantee the fourth. A filesystem may be read-only, credentials may be
missing, requirements may contradict each other, or the requested fact may be
unknowable.

The Markdown migration path therefore fails closed. It embeds the exact input
bytes, derives a byte-complete nonblank span map, emits each span as
`unresolved`, and requires a content-bound review disposition plus a
source-wide review seal. This proves that every span received an explicit
decision. It does not pretend that a compiler can infer the meaning of
arbitrary natural language.

## 2. The determinism contract

For one compiled program `P`, input `I`, trusted binding set `B`, and ordered
stream of external outcomes `O`, the Axiom VM is intended to implement a
function:

```text
execute(P, I, B, O) -> result, ledger
```

The same valid tuple must produce the same Axiom state transitions, result, and
semantic ledger contents. Live execution is not a closed tuple: a model, tool,
validator, verifier, network, filesystem, clock, or operator may produce a
different `O`. Replay closes that boundary by substituting the recorded
outcomes.

| Layer | Deterministic claim | Important limit |
| --- | --- | --- |
| Lexing and parsing | Same valid scalar-value source bytes produce the same syntax tree or diagnostic | Diagnostics are toolchain-versioned |
| Type and obligation checking | Same source and toolchain produce the same acceptance decision | Trusted compiler bugs are still possible |
| AIR generation | Same executable semantics produce the same canonical AIR semantics | Source provenance is tracked separately |
| Semantic hash | Comments and authoring trivia do not change executable identity | A semantic compiler bug would invalidate this premise |
| Artifact hash | Exact canonical AIR, including source provenance, is content-addressed | It identifies bytes, not truth |
| VM control | Same AIR, input, binding identity, and external outcomes produce the same transitions | External outcomes may differ live |
| Effect identity | Effect sites, arguments, request hashes, and write idempotency keys are explicit | The host must implement the declared behavior |
| Successful completion | Every declared obligation has matching, unconsumed, current evidence | A dishonest verifier can issue bad evidence |
| Replay | Recorded effects are matched in order and no live effect is substituted | Replay proves reproducibility, not current-world truth |
| Live model output | No equality guarantee | Temperature zero and seeds are provider hints, not semantics |

This taxonomy prevents “deterministic” from becoming an unfalsifiable
marketing word. Axiom targets deterministic **control**, **authority**,
**validation**, **failure**, and **replay**. It does not claim deterministic
live inference.

### 2.1 There is still a harness

A language cannot execute without an implementation. The parser, compiler, AIR
verifier, VM, adapter boundary, capability bindings, ledger, and operating
system controls are a harness.

Axiom's contribution is to move orchestration policy out of scattered,
application-specific prompt strings and host callbacks into a small,
versioned, checkable language. It can make much of today's ad hoc harness
engineering declarative and portable. It cannot safely abolish the runtime
that enforces those declarations.

## 3. Selection criteria

Features are selected for Axiom according to a different objective from a
general-purpose language. The important questions are:

1. Can the compiler prove that a requirement cannot be silently omitted?
2. Can every authority-bearing operation be located statically?
3. Is every nondeterministic boundary explicit and recordable?
4. Is behavior fully specified across conforming runtimes?
5. Can invalid or ambiguous input fail closed?
6. Can execution and inference be bounded before they start?
7. Can a run be audited and replayed without the original model?
8. Does the feature keep model-facing context local and compact?
9. Can the feature evolve without silently changing existing programs?
10. Is its semantic value worth its implementation and verification surface?

“Popular,” “terse,” and “fast in a benchmark” are secondary. A construct that
is convenient for humans but introduces implicit authority, unbounded search,
unspecified ordering, or hidden control flow is a poor fit for the certified
core.

## 4. Language comparison at a glance

| Source language | Most valuable lesson | Main danger for Axiom | Decision |
| --- | --- | --- | --- |
| Go | Small specification, explicit operational style, compatibility promise, integrated tooling | Discardable errors, `nil`, implicit interfaces, nondeterministic concurrency | Adopt simplicity, compatibility discipline, explicit operations, and fuzzable tooling; reject the ambiguous edges |
| Rust | Ownership, affine resources, `Result`, exhaustive enums, explicit trust boundary, lockfiles | General borrow-checking complexity, panic paths, and an `unsafe` escape hatch | Adopt linear obligation/evidence ideas and locks now; add typed results and exhaustive matching later; no source-level safety bypass |
| Java | Stable specification and ecosystem, nominal types, records, sealed hierarchies | `null`, implicit exception flow, reflection, class loading, shared-memory complexity | Adopt nominal records/propositions and compatibility suites; reject ambient runtime dynamism |
| Kotlin | Non-null-by-default ergonomics, sealed types, concise exhaustive matching | Interop leaks, implicit receivers/extensions, coroutine scheduling, broad syntax | Preserve non-null defaults and plan exhaustive matching; reject semantic magic |
| C++ | RAII, value semantics, explicit resource ownership, contracts culture | Undefined/unspecified behavior, implicit conversions, macros, overload complexity | Adopt fail-safe resource scopes and contracts; reject every semantics-by-implementation gap |
| Starlark | A deliberately deterministic and hermetic subset can outperform a feature-rich host language for configuration | It is not an effect or proof system | Adopt bounded, frozen, non-reflective execution; add Axiom's obligations and effects |
| CUE | Constraints and schemas can make invalid configurations unrepresentable | Constraint solving is not an effect-ordering model | Adopt validation and refinement ideas; keep execution order explicit |
| Rego | Separate policy decisions from effect mechanisms | A policy answer alone is not proof that an effect is safe or succeeded | Use policy at validation/authorization gates; retain receipts and verifier evidence |

## 5. Go: simplicity and compatibility over cleverness

Go's most important contribution is not a particular keyword. It is the
discipline of keeping the language and toolchain understandable as one system.
The [Go specification](https://go.dev/ref/spec) is compact enough to be used as
an engineering document, and the
[Go 1 compatibility promise](https://go.dev/doc/go1compat) makes ecosystem
stability an explicit project responsibility rather than an accident.

The [Go memory model](https://go.dev/ref/mem) is also instructive because it
states what synchronization is required and explicitly advises programmers not
to be clever around shared memory. Axiom should go further: certified programs
should not have data races or scheduler-dependent result ordering at all.

### 5.1 Strengths worth taking

- **A small, readable core.** A language used as an authority document must be
  reviewable by people who did not implement it.
- **One conventional toolchain.** Parse, check, compile, format, test, fuzz,
  package, and conformance commands should agree on semantics.
- **Compatibility as a contract.** Once a program is valid for a stable Core
  version, a later compatible toolchain must not silently reinterpret it.
- **Explicit operational code.** An effect should look like an effect, not like
  an innocent property lookup or overloaded operator.
- **Errors as values in ordinary APIs.** Failure should be visible in signatures
  and testable without language-level stack unwinding.
- **Built-in testing and fuzzing culture.** Deterministic languages need
  mutation, property, golden-vector, and cross-platform tests as first-class
  project infrastructure, not optional downstream work.

### 5.2 Weaknesses Axiom should not inherit

- A Go caller can discard an error. Axiom's eventual typed result must require
  exhaustive handling before a value crosses an effect boundary or completes a
  task.
- `nil` introduces a large family of states not visible in an ordinary type.
  Axiom Core has no ambient nullable reference. Absence must be represented by
  an explicit future optional or result type.
- Implicit interface satisfaction is elegant for application code but too
  implicit for authority. A capability must be declared, bound, locked, and
  inspectable.
- Goroutine scheduling and channel selection can be validly nondeterministic.
  Axiom must not expose scheduler choice as semantic choice.
- Map iteration order and other deliberately unspecified behavior are
  unacceptable in canonical artifacts or ledgers.

### 5.3 Axiom decision

Adopt Go's small-spec and compatibility culture, explicit effect-shaped
syntax, and integrated conformance tooling. Do not adopt `nil`, discardable
failure, implicit capability satisfaction, or scheduler-dependent
concurrency.

## 6. Rust: make authority and proof resources explicit

Rust demonstrates that resource protocols can be enforced by a type system
rather than by documentation. The
[ownership model](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html)
makes use, transfer, and lifetime visible. Its
[`Result<T, E>` model](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html)
makes recoverable failure part of a function's output, and exhaustive enum
matching gives the compiler a place to prove that all outcomes were handled.

Rust also distinguishes a checked language from explicitly trusted operations
through its [unsafety rules](https://doc.rust-lang.org/reference/unsafety.html),
while its reference documents classes of
[undefined behavior](https://doc.rust-lang.org/stable/reference/behavior-considered-undefined.html)
that safe Rust is designed to avoid. Cargo's locked mode documents the value of
refusing an execution when the
[lockfile would change](https://doc.rust-lang.org/cargo/commands/cargo-build.html).

### 6.1 Strengths worth taking

- **Linear and affine reasoning.** An obligation is not a Boolean flag that can
  accidentally be overwritten. Evidence is proposition-specific and consumed
  when used.
- **Untrusted values have a distinct type.** A `Candidate<T>` is not a `T`.
  It must pass through a declared validator.
- **Recoverable failure belongs in the type system.** A future
  `Result<T, E>` should make retry, fallback, escalation, and terminal failure
  explicit.
- **Exhaustive variants.** A future `match` should fail compilation when a new
  outcome or policy variant is unhandled.
- **The trusted boundary should be named.** Tool, model, validator, and verifier
  bindings are trusted host integrations. They must not masquerade as pure
  expressions.
- **Dependency state should be locked.** Axiom's implemented AXLOCK profiles
  freezes the toolchain identity, semantic and artifact hashes, port
  signatures, inferred least-authority port sets, static operation/effect
  bounds, and optional host-binding fingerprint for one compiled program.

### 6.2 Weaknesses Axiom should not inherit

- A general-purpose borrow checker, lifetime language, and alias model would
  add major surface area without helping a finite, JSON-shaped workflow core.
- Source-level `unsafe` would defeat Axiom's central promise. Trust belongs at
  an externally configured binding boundary, not in a block that makes a
  program look certified after checks were disabled.
- Panic-style unwinding should not be ordinary task control flow. Expected
  failures should be typed; runtime defects should terminate visibly.
- Rust's complete type, trait, macro, async, and concurrency systems are much
  larger than Axiom needs. Feature richness increases the proof burden.
- A lockfile improves reproducibility but does not prove a dependency benign.
  Axiom locks must be combined with signatures, review, sandboxing, and
  conformance.

### 6.3 Axiom decision

The current obligation/evidence discipline and `Candidate<T>` boundary are
Rust-inspired without importing Rust's general memory model. AXLOCK
adopts lockfile discipline for a compiled workflow. `Result<T, E>` and
exhaustive `match` are high-priority roadmap items; neither is implemented
Axiom source syntax today.

## 7. Java: nominal contracts and long-lived compatibility

The [Java Language Specification](https://docs.oracle.com/en/java/javase/26/docs/specs/jls/index.html)
shows the value of a versioned, normative language definition with a large
compatibility horizon. Java's nominal type system gives a stable identity to a
declared contract. Records and sealed classes make data carriers and closed
variant families explicit, while the
[exception rules](https://docs.oracle.com/en/java/javase/26/docs/specs/jls/jls-11.html)
demonstrate both the value and cost of putting some failure information into
signatures.

The
[Java memory model](https://docs.oracle.com/en/java/javase/26/docs/specs/jls/jls-17.html)
is a reminder that shared mutable state requires a large semantic framework.
Axiom should avoid needing one in its certified core.

### 7.1 Strengths worth taking

- **Nominal identity.** A proposition means the declared proposition, not any
  structurally similar object. Evidence for one proposition cannot satisfy
  another.
- **Records for closed data.** Axiom records have an exact declared shape and
  canonical representation.
- **Closed variants.** Sealed hierarchies motivate future exhaustive result and
  policy types.
- **Stable bytecode boundary.** AIR plays a role analogous to a portable
  execution artifact, but is deliberately smaller and independently verified
  before execution.
- **Compatibility tests over promises alone.** Stable releases need old-program
  corpora, golden AIR, and behavior vectors.
- **Mature diagnostics and tooling expectations.** A language intended to
  replace operational Markdown needs source locations, stable error codes, an
  editor protocol, and migration tooling.

### 7.2 Weaknesses Axiom should not inherit

- `null` creates implicit partiality. Axiom should keep values non-null by
  default and model absence explicitly.
- Exceptions create nonlocal control edges. Routine workflow failure should be
  represented in a closed result type and handled at a visible site.
- Reflection, dynamic class loading, service discovery, and classpath order can
  create ambient authority and deployment-dependent semantics.
- Shared mutable objects, thread scheduling, and initialization order are an
  unnecessary determinism burden for a workflow language.
- VM/JIT implementation stability is useful for performance but does not make
  external I/O or wall-clock behavior deterministic.

### 7.3 Axiom decision

Keep nominal propositions, exact records, a portable verified AIR, and strong
compatibility testing. Reject ambient `null`, reflection, dynamic loading,
classpath resolution, and implicit exception control.

## 8. Kotlin: explicit absence and exhaustive ergonomics

Kotlin's [null-safety design](https://kotlinlang.org/docs/null-safety.html)
shows how a common failure mode can be moved from convention into types.
Its [sealed classes and interfaces](https://kotlinlang.org/docs/sealed-classes.html)
support exhaustive `when` expressions and concise closed-domain modeling.

Kotlin is also a useful warning: a pleasant DSL surface can accumulate implicit
receivers, extensions, operator overloading, platform types, annotation
processing, compiler plugins, and coroutine scheduling. Those features are
productive in application development but make authority resolution and
portable semantics harder to audit.

### 8.1 Strengths worth taking

- Values should be non-null unless absence is declared.
- Closed result families should be concise to construct and exhaustive to
  consume.
- The common safe path should require less syntax than an unsafe or ambiguous
  path.
- Human-authored workflow syntax should remain readable enough for code review;
  compactness is useful only while semantics stay obvious.

### 8.2 Weaknesses Axiom should not inherit

- Platform types weaken null-safety at an interop boundary. Axiom adapters must
  normalize and validate host values before they enter the VM.
- Extension resolution and implicit receivers can hide which capability a call
  uses.
- Operator overloading can make an effect look pure.
- Exceptions inherited from the JVM preserve hidden control flow.
- Coroutine code can be structured while still depending on cancellation,
  scheduler, and interleaving behavior.
- Compiler plugins that can rewrite semantics undermine a small certified
  language.

### 8.3 Axiom decision

Keep Core values non-null by default. Add an explicit optional type only with
canonical wire semantics. Design future result variants and `match` for
exhaustiveness and readable authoring. Do not add implicit receivers,
user-defined operator semantics, semantic compiler plugins, or unstructured
coroutines.

## 9. C++: resource discipline without semantic escape hatches

The
[C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines)
capture valuable principles: express ownership, bind resource lifetime to
scope, preserve invariants, prefer value semantics, and make interfaces carry
contracts. WG21's ongoing work on
[library hardening](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p3471r4.html)
and
[safety profiles](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2026/p4186r0.html)
also demonstrates how difficult it is to retrofit deterministic safety onto a
large language with decades of compatibility constraints.

### 9.1 Strengths worth taking

- **RAII as a runtime implementation principle.** Ledgers, leases,
  transactions, and temporary capabilities should close on every exit path.
- **Value semantics.** Canonical immutable records are easier to reason about
  than identity-bearing mutable objects.
- **Contracts and invariants.** Preconditions, postconditions, and task
  obligations should be executable and checked.
- **Zero hidden allocation of authority.** Acquiring a resource or capability
  should be syntactically and operationally visible.
- **Performance budgets matter.** A deterministic system that can be exhausted
  by unbounded parsing, nesting, effects, or response size is not operationally
  safe.

### 9.2 Weaknesses Axiom should not inherit

- Undefined, unspecified, and implementation-defined behavior are unacceptable
  in a portable agent instruction standard.
- Raw memory, pointer identity, data races, and object lifetime rules add no
  value to JSON-shaped orchestration.
- Macros and template metaprogramming create another language before the
  language.
- Implicit conversions and overload resolution can change meaning far from the
  call site.
- ABI and compiler differences can make “same source” an incomplete identity.
- Deterministic destruction cannot roll back an external side effect. Future
  Axiom transactions must use explicit commit, compensation, or saga
  semantics, not pretend arbitrary tools are reversible.

### 9.3 Axiom decision

Apply RAII and contract principles inside the toolchain and future scoped
resource syntax. Continue rejecting unsafe integers, non-finite numbers,
implicit conversions, hidden overloads, macros, pointers, undefined behavior,
and magical rollback.

## 10. Starlark: a deterministic subset is a feature

[Starlark](https://github.com/bazelbuild/starlark) is explicitly designed as a
deterministic, hermetic configuration language. Its
[specification](https://github.com/bazelbuild/starlark/blob/master/spec.md)
restricts a Python-like language to make evaluation repeatable and suitable for
parallel build systems. Frozen values, restricted mutation, no arbitrary host
imports, and the absence of general dynamic evaluation are directly relevant
to Axiom.

### 10.1 What Axiom adopts

- No ambient filesystem, environment, network, clock, randomness, or process
  access. All such access is a declared port.
- No reflection or `eval`.
- No recursion or unbounded loop in the certified Core; Core 0.2 repeats are
  post-test, literal-bounded, effect-bearing, and admitted recursively.
- Immutable bindings and canonical data.
- Deterministic collection ordering where ordering is semantic.
- A deliberately smaller language than its implementation language.

### 10.2 Where Axiom must go further

Starlark evaluates configuration; it does not model untrusted model candidates,
write effects, proof obligations, evidence consumption, idempotency keys, or
replay ledgers. Hermetic expression evaluation is necessary for Axiom but not
sufficient. Axiom adds an explicit effect and proof protocol around the pure
subset.

## 11. CUE: constraints belong before effects

[CUE](https://cuelang.org/docs/) treats values and constraints uniformly, with
a formally described
[constraint-oriented specification](https://cuelang.org/docs/reference/spec/).
It is a strong model for schema composition, defaults, closedness, and
detecting conflicts before a configuration is used.

### 11.1 What Axiom adopts

- Invalid shapes should be rejected before an effect.
- Constraints should compose monotonically where possible.
- Validation should produce a narrower trusted value, not merely a Boolean.
- Schemas are executable interoperability artifacts, not prose hints.
- Conflicting requirements should fail instead of allowing last-writer-wins.

### 11.2 What Axiom does not adopt

Constraint unification does not define effect order, evidence freshness,
idempotency, or recovery. Axiom keeps orchestration operations explicit and
ordered. Future refinement types may borrow CUE-like constraints, but the
compiler must keep them decidable, bounded, canonical, and portable.

## 12. Rego: policy decides; mechanisms execute and prove

[Rego](https://www.openpolicyagent.org/docs/policy-language) separates
declarative policy evaluation from the application that enforces the decision.
That separation is useful for Axiom: authorization logic should be inspectable
and testable without being embedded in arbitrary tool code.

### 12.1 What Axiom adopts

- Policy is data-driven and side-effect free.
- Authorization defaults should fail closed.
- Conflicting complete policy decisions should be errors, not order-dependent
  winners.
- Policy decisions should be recordable inputs to a validator or verifier.
- Mechanism and policy should have separate tests and version identities.

### 12.2 What Axiom does not adopt

A policy engine is not an orchestrator and a decision is not an effect receipt.
“Allowed” does not prove that an operation happened or that postconditions hold.
Axiom retains explicit `act`, returned receipts, proposition-specific
verification, and obligation satisfaction.

## 13. The resulting Axiom architecture

The language synthesis is intentionally asymmetric: Axiom borrows safety
properties, not feature counts.

```text
Markdown or human-authored .ax
          |
          | lossless import + explicit review, when migrating
          v
      Axiom source
          |
          | parse, type-check, obligation-check, lower
          v
  canonical AIR/0.1 or AIR/0.2 -----------+
          |                               |
          | strict independent verify     | semantic + artifact hashes
          v                               v
      deterministic VM <------------ paired AXLOCK
          |
          +-- observe ------> read binding ---------+
          +-- infer --------> AXIP model adapter ---+--> ordered outcomes
          +-- validate -----> validator ------------+
          +-- act ----------> write binding --------+
          +-- verify -------> verifier -------------+
          |
          v
  hash-chained durable ledger --> exact effect/control replay
```

### 13.1 Implemented certified-core ideas

- **Closed data:** records, finite ordered lists, safe integers, Booleans,
  Unicode scalar-value text, canonical JSON, and no implicit conversions.
- **Explicit effects:** `observe`, `infer`, `validate`, `act`, and `verify`
  identify the exact declared port.
- **VM-owned control:** Core 0.2 adds exhaustive exact-Boolean `if` and
  post-test `repeat max N` without allowing raw candidates to steer them.
- **Finite repetition:** repeat bodies are effect-bearing, conditions depend
  on a body-local binding, iteration frames are fresh, and exhaustion fails
  with `AX2140` after at most 1,024 iterations.
- **Untrusted inference:** `infer` yields `Candidate<T>`; only a declared
  validator can produce a usable `T`.
- **Proof-carrying completion:** named obligations require nominal verifier
  evidence, and `complete` is rejected while any obligation is unresolved.
- **Evidence freshness:** state evidence is invalidated by later writes;
  event evidence records an occurrence.
- **Idempotent write identity:** every `act` has an explicit idempotency key;
  the host remains responsible for honoring it.
- **Portable limits:** every inference declares input bytes, output bytes, and
  attempts; host deadlines bound live adapter calls.
- **Canonical executable artifact:** strict edition-paired AIR is revalidated
  before it executes, even when supplied directly.
- **Two hashes:** the semantic program hash excludes source provenance and
  authoring trivia; the artifact hash binds the exact canonical AIR including
  `sourceHash`.
- **Unicode portability:** Axiom accepts Unicode scalar values, rejects
  unpaired UTF-16 surrogates, orders canonical object keys and strings by scalar
  value, and intentionally does not normalize distinct strings silently.
- **Exact numeric domain:** canonical JSON rejects non-finite and unsafe
  integers and normalizes negative zero.
- **Locked deployment:** the paired AXLOCK binds the exact program and toolchain,
  port signatures, inferred port capabilities, static operation/effect/model
  attempt/write bounds, and an optional trusted host-binding fingerprint.
- **Durable audit:** the CLI can create an append-only ledger without
  overwriting an existing file; each canonical entry is written and `fsync`ed
  before it becomes committed VM history. Reads are bounded and validate UTF-8,
  canonical form, sequence, linkage, effect intent/outcome structure, and
  hashes.
- **Exact replay:** replay matches recorded effect requests at the current
  dynamic program site and, for Core 0.2, authenticates the full ordered
  effect/control/obligation transcript with iteration vectors; it fails on
  divergence instead of calling the outside world.
- **Fail-closed Markdown migration:** exact bytes, compiler-derived spans,
  content anchors, explicit dispositions, and a source-wide review seal.

These properties improve determinism because the model is no longer the
interpreter of the workflow. The model proposes a value at a declared site; the
runtime retains authority.

### 13.2 Explicitly not implemented language features

The following concepts remain design roadmap rather than accepted Core 0.2
source syntax:

- `Result<T, E>` and user-defined closed variants;
- exhaustive `match`;
- effect or capability regions;
- package and module imports;
- a dependency registry or transitive module lock;
- scoped resource and transaction syntax;
- bounded structured concurrency;
- runtime-generated executable modules;
- general recursion or unbounded/stateful loops;
- a source-level trust-bypass construct.

AXLOCK locks one already compiled program and its binding contract. It
must not be confused with a future package manager lock that resolves and
authenticates a transitive module graph.

## 14. Why this is more deterministic than Markdown

Markdown has no standard distinction between a requirement, example,
preference, exception, comment, capability, proof, and completion condition. A
model must reconstruct those roles from prose on every invocation. Ordering,
scope, conflicts, and whether a checkbox is normative are conventions rather
than execution semantics.

Axiom assigns each role a machine-checkable representation:

| Markdown concern | Axiom representation |
| --- | --- |
| “Must do X” | Named task obligation |
| “Use this tool” | Declared typed port and explicit effect statement |
| “Do not write” | Absence of write capability, later strengthened by effect regions |
| “Check that X is true” | Proposition-specific verifier evidence |
| “The model suggests Y” | `Candidate<Y>` |
| “Y is safe to use” | Validator narrowing to `Y` |
| “Retry at most twice” | Declared attempt bound |
| “Do this operation once” | Program/site/key effect identity plus host deduplication |
| “Done” | `complete` after all obligations are satisfied |
| “This paragraph is only explanation” | Explicit reviewed `non_normative` disposition |
| “These instructions came from this file” | Embedded source bytes, AXMAP, span hashes, review seal |

This does not imply that all Markdown should disappear. Markdown remains
appropriate for explanation, design discussion, tutorials, and prose that no
machine should execute. Axiom should replace Markdown as an **operational agent
instruction format**, not as a universal human document format.

## 15. Token efficiency without model-specific semantics

The decisive optimization is architectural: the model should not consume the
whole language file on every inference.

For inference site `s`, the model-facing input is approximately:

```text
frame(s) =
  protocol reference
  + site intent
  + evaluated site arguments
  + reachable input/output schemas
  + active obligation identifiers
  + explicit context references
```

It does not include unrelated task bodies, tool implementations, previous
conversation, unused record definitions, source comments, Markdown provenance,
or old receipts that were not passed to the site.

### 15.1 Implemented efficiency choices

- **Compile once, execute many times.** Human-readable source is not the wire
  prompt.
- **Node-local frames.** Only values referenced by the current `infer` are
  dynamic input.
- **Reachability-pruned schemas.** Unrelated record definitions are omitted.
- **Compact versioned AXIP keys.** The adapter wire form is mechanically
  reversible and strict.
- **Content-addressed context.** Stable context and the semantic prologue use
  SHA-256 references.
- **Cacheable prologue.** An adapter may use the referenced form only when it
  advertises the exact installed prologue hash; otherwise Axiom sends the
  inline form.
- **Portable UTF-8 byte budgets.** Every runtime can enforce bytes before and
  after a call, independent of provider tokenization.
- **Attempt budgets.** Repeated inference has a static upper bound.

Tokens remain useful telemetry, but they cannot be normative: tokenization
changes across providers, model families, and revisions. Byte limits are a
portable safety bound; provider token limits may be conservative adapter-level
optimizations.

### 15.2 Efficiency work that preserves semantics

Future protocol versions may add:

- content-addressed schema dictionaries;
- interned type, field, proposition, and capability identifiers;
- canonical binary encoding between runtime components;
- static liveness analysis for context values;
- declared context chunk priorities and byte quotas;
- delta frames when a provider can prove cache continuity;
- provider-specific token estimates recorded as non-normative telemetry; and
- a benchmark corpus reporting frame bytes, expanded bytes, provider tokens,
  cache hits, attempts, schema-valid rate, validator-valid rate, and end-to-end
  completion rate.

These optimizations must decode to the same normalized request. A provider
profile may reduce cost but may not remove an obligation, enlarge authority,
change output validation, or alter failure behavior.

### 15.3 What not to optimize

Compressing `.ax` source into cryptic punctuation is not the main token win,
because the model should not repeatedly read source. Human reviewability,
unambiguous parsing, stable diagnostics, and diff quality are more valuable
than shaving authoring tokens. A formatter may offer a compact canonical form,
but source and AIR must retain the same semantics.

## 16. Model independence

Model independence is a property of the boundary, not a claim that models have
equal capabilities.

Every adapter receives the same normalized AXIP inference request and returns
one normalized outcome:

- `candidate`;
- `need_context`; or
- `fail`.

Provider messages, roles, SDK objects, authentication, native structured
output, streaming, and response envelopes remain inside the adapter. Optional
features such as a deterministic seed or provider-side schema mode are
optimizations. They are not language semantics.

A model-independent program therefore preserves across adapters:

- AIR and program hashes;
- task operation order;
- obligation identities;
- tool modes and signatures;
- validators and verifiers;
- idempotency keys;
- byte and attempt limits;
- completion conditions; and
- replay rules.

The candidate can differ. A weak or incompatible model can fail the schema,
exhaust the byte budget, return a poor candidate rejected by validation, or
fail the conformance probe. It cannot legally bypass validation or satisfy an
obligation merely by claiming success.

No prompt syntax is literally understood by every possible model. Portability
comes from adapters, strict framing, schema validation, conformance tests, and
the fact that the VM—not the model—interprets Axiom.

## 17. Dynamic harnesses, safely defined

“A language that spins up a dynamic harness without a harness” is
self-contradictory. A useful, implementable version of the idea is:

> An Axiom program may construct or select an orchestration plan as data, but
> no generated plan receives authority until a deterministic compiler,
> verifier, lock step, and capability intersection accept it.

The safe protocol is two-phase:

```text
propose plan as Candidate<Plan>
        |
        v
validate plan structure and policy
        |
        v
compile in an isolated, version-pinned toolchain
        |
        v
strictly verify AIR and static bounds
        |
        v
intersect requested capabilities with parent grant
        |
        v
lock semantic/artifact/module/binding identities
        |
        v
instantiate as a child run with its own ledger
```

Non-negotiable rules for this feature are:

1. A child cannot grant itself a capability absent from the parent grant.
2. A model cannot mutate the currently executing AIR.
3. A generated module cannot discharge the parent's obligations merely by
   redefining them.
4. Compilation, verification, and locking occur before any child effect.
5. Recursion depth, child count, operations, effects, model attempts, bytes,
   time, and ledger growth are bounded.
6. Parent and child semantic/artifact/module hashes are linked in both ledgers.
7. Failure, cancellation, and compensation are explicit outcomes.
8. Cached generated programs are keyed by all semantic inputs and binding
   identities.

Initially, dynamic orchestration should use precompiled strategy variants such
as bounded retry, fallback, review escalation, and deterministic fan-out/join.
Runtime compilation should come only after modules, effect regions, typed
results, and resource bounds are stable.

## 18. Roadmap in dependency order

### 18.1 Typed results and exhaustive matching

Add closed variants and:

```text
Result<T, E>
Option<T>
match value { ... }
```

Requirements:

- every variant is explicit and canonically tagged;
- every `match` is exhaustive;
- no wildcard is accepted for a public evolving result unless the author opts
  into version-forward behavior;
- effectful and completion paths cannot use an unhandled error;
- `Candidate<T>` cannot control authority-bearing branches until validated;
- routine failures do not unwind through hidden exception edges; and
- AIR verification independently rechecks branch typing and obligation flow.

This is the most important lesson from Rust and Kotlin that Core has not yet
implemented.

### 18.2 Effect and capability regions

Add lexical declarations for the exact resources and modes a block may use.
The compiler should infer actual usage and reject both undeclared use and
unnecessarily broad grants under a strict profile.

Effects should be resource-specific:

```text
filesystem.read("repo/**")
filesystem.write("repo/src/**")
network.connect("api.example.com:443")
process.exec("git", args_schema)
secret.use("release-token", destination)
```

An effect region is not an operating-system sandbox. The host must enforce the
same resource scope, and the lock must bind the host policy implementation.
Resource-specific effects will also permit precise state-evidence invalidation
instead of invalidating every state proposition after every write.

### 18.3 Modules and packages

Modules require:

- closed exports and no ambient search path;
- content-addressed source and AIR artifacts;
- versioned language and protocol feature declarations;
- a canonical dependency graph;
- exact transitive hashes in a package lock;
- signature and provenance support;
- cycle rules with no initialization-order ambiguity;
- no network resolution during locked execution; and
- compatibility checks for imported port, proposition, and type identities.

The resolution algorithm itself is part of the specification. Two conforming
toolchains must not select different dependency graphs.

### 18.4 Scoped resources and transactions

Borrow C++'s resource discipline without pretending external state is memory.
Add explicit scopes for leases, temporary credentials, files, and sessions.
Cleanup must run on success, typed failure, timeout, and cancellation.

For writes, distinguish:

- atomic commit supported by one binding;
- idempotent retry;
- compensating action;
- saga across several bindings; and
- irreversible effect.

The type/effect system should prevent syntax from calling an irreversible
operation “transactional.”

### 18.5 Bounded structured concurrency

Concurrency is acceptable only when its observable result does not depend on
the scheduler.

A future construct should require:

- a finite statically or input-bounded branch set;
- immutable branch inputs;
- disjoint writes or an explicit deterministic conflict rule;
- ordered result collection by declared key, not completion time;
- complete branch ledger subchains;
- deterministic cancellation semantics;
- no “first response wins” in certified mode; and
- an independently verified merge function.

Performance may be parallel. Semantics must be equivalent to one specified
serial order.

### 18.6 Dynamic plans

After results, effects, modules, and bounds are stable, permit plans as typed
data using the two-phase protocol in section 17. The default deployment policy
should require a signed set of allowable module templates and a human or policy
approval for any capability increase.

### 18.7 Formalization and hostile-runtime hardening

- Give AIR a small-step operational semantics.
- State and prove obligation preservation and progress properties for valid
  Core programs.
- Publish canonical JSON, Unicode, hashing, AIR, AXIP, AXLOCK, and ledger test
  vectors.
- Run independent implementations against the same vectors.
- Sandbox host bindings and bind sandbox policy into deployment identity.
- Add signed locks, signed ledgers, transparency metadata, and reproducible
  release artifacts.
- Define crash recovery at every write boundary.
- Keep parser, AIR, ledger, protocol, schema, and adapter inputs size/depth
  bounded.

## 19. Compatibility and evolution policy

Axiom should separate three channels:

1. **Certified Core:** frozen semantics, independent verifier, compatibility
   promise, and conformance vectors.
2. **Preview features:** explicitly gated in source and AIR; never accepted by a
   Core-only verifier.
3. **Proposals:** design documents with no executable status.

Every semantic feature needs:

- a grammar change;
- static typing and obligation-flow rules;
- canonical AIR representation;
- independent AIR validation;
- VM semantics;
- ledger and replay semantics;
- hashing and lock implications;
- byte/resource bounds;
- adversarial tests;
- a migration story; and
- a protocol impact statement.

Unknown source features, AIR operations, lock fields, or protocol versions must
fail closed. A later toolchain may add diagnostics or performance improvements
without changing existing semantic hashes. A change that alters executable
meaning requires a language or AIR version change.

Go's compatibility promise is the model for user trust; Rust's lock discipline
is the model for deployment identity; Java's long-lived conformance culture is
the model for independent runtimes.

## 20. Launch acceptance criteria

A launch-ready language is more than a compiler that passes example tests.
Before calling a Core version stable, the project should require:

### 20.1 Language and implementation

- normative grammar and operational semantics;
- no undocumented accepted syntax;
- stable diagnostic codes for machine use;
- canonical formatter and linter;
- strict AIR verifier isolated from compiler assumptions;
- reference runtime with bounded inputs and effects;
- published support and compatibility windows; and
- a security and threat-model document.

### 20.2 Determinism suite

- repeated compilation produces byte-identical canonical AIR;
- semantic hashes remain stable across comments and formatting;
- artifact hashes change when exact source provenance changes;
- canonical ordering agrees across supported operating systems and runtimes;
- Unicode scalar, escaping, non-normalization, and invalid-surrogate vectors;
- safe-integer, negative-zero, depth, duplicate-key, and malformed-JSON vectors;
- repeated fixture runs produce equivalent results and ledgers;
- replay performs zero live model/tool effects and rejects every mismatch;
- lock verification detects source, artifact, port, bound, toolchain, and
  binding changes; and
- crash tests validate that a committed effect outcome is never missing from
  durable audit history.

### 20.3 Adversarial suite

- malformed and noncanonical AIR mutation corpus;
- parser, schema, AXIP, Markdown, AXMAP, lock, and ledger fuzzing;
- candidate smuggling attempts across validators;
- forged, reused, wrong-proposition, consumed, and stale evidence;
- state evidence invalidation after writes;
- effect request/outcome reordering and truncation;
- oversized, cyclic, accessor-bearing, sparse, or custom-prototype values;
- adapter timeouts that include encode, transport, read, and decode;
- idempotency collision and retry tests; and
- hostile Markdown edits that preserve one line but alter its context.

### 20.4 Cross-platform and supply chain

- CI on every pull request and protected branch;
- supported Node and operating-system matrix;
- clean install from the exact package lock;
- typecheck, complete tests, coverage floor, determinism suite, and package
  verification;
- CodeQL or equivalent static analysis;
- dependency and action update automation;
- GitHub Actions pinned to immutable commit identifiers;
- release tag/package-version agreement;
- provenance attestations and immutable release artifacts; and
- no publish step that can bypass the same checks.

### 20.5 Model and adapter portability

- AXIP conformance probe for every supported adapter;
- inline and exact-hash cached-prologue paths;
- schema-valid and schema-invalid response vectors;
- retryable and terminal failure vectors;
- byte-limit enforcement around the complete provider envelope;
- exact run/node identity echoing;
- unknown-context and duplicate-reference rejection; and
- published quality benchmarks that are clearly separate from semantic
  conformance.

Passing this suite supports a bounded claim: the implementation conforms to the
specified deterministic control plane. It still does not make a provider's live
model computation deterministic.

## 21. Features intentionally excluded from the certified core

- ambient network, filesystem, environment, clock, randomness, process, or
  secret access;
- reflection, `eval`, dynamic symbol lookup, and semantic compiler plugins;
- implicit conversions, truthiness, nullable references, and floating-point
  arithmetic;
- unspecified map iteration or scheduler-dependent result order;
- general recursion, unbounded loops, and unbounded retries;
- source macros or compile-time execution with external effects;
- exceptions as routine workflow control;
- a source-level `unsafe` or “trust me” escape hatch;
- model-native direct tool authority;
- completion based on a model saying that it is done;
- automatic semantic conversion of arbitrary prose; and
- claims that a random seed makes a hosted model reproducible.

These exclusions are not missing general-purpose language conveniences. They
are part of Axiom's product.

## 22. Final design position

Axiom should not try to be Go, Rust, Java, Kotlin, or C++ for agents. Those
languages let humans describe arbitrary computation. Axiom's certified core
has a narrower job: describe bounded agent orchestration whose authority,
uncertainty, evidence, failure, and completion can be checked.

The synthesis is:

- Go's simplicity, tooling, and compatibility discipline;
- Rust's resource-aware types, explicit recoverable failure, exhaustive
  variants, named trust boundary, and locking;
- Java's nominal contracts, portable verified artifact, and long-term
  conformance expectations;
- Kotlin's non-null defaults and exhaustive ergonomics;
- C++'s scoped resource discipline and contract mindset, without undefined
  behavior;
- Starlark's hermetic deterministic subset;
- CUE's constraint-first validation; and
- Rego's separation of policy from mechanism.

The features Axiom must uniquely add are proof-carrying completion,
model-output quarantine through `Candidate<T>`, explicit effect sites,
content-bound Markdown migration, portable node-local model frames, and exact
ledger replay.

That combination can make agent execution substantially more deterministic,
auditable, portable, and token-efficient than operational Markdown. It can
replace Markdown where Markdown is being misused as executable policy. It
cannot turn uncertainty into certainty, make dishonest trusted code honest,
guarantee an impossible task, or eliminate the runtime that enforces the
language. Keeping those limits explicit is how Axiom can become credible
infrastructure rather than another prompt convention.
