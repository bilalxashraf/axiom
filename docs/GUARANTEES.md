# Axiom guarantees and determinism model

## 1. Scope

This document separates properties Axiom can enforce from properties that
remain outside the language. It applies to the certified Axiom Core 0.1
execution path. A guarantee below is conditional on all of the following:

- the source or AIR is accepted by the Core 0.1 checker and strict AIR
  verifier;
- the compiler, verifier, VM, canonical serializer, and cryptographic
  primitives execute as specified;
- the exact program, task input, runtime policy, and trusted binding set
  identified for the run are the ones actually used; and
- trusted tools, validators, and verifiers uphold their declared contracts.

Those conditions are part of the trusted computing base. Axiom reduces and
records that base; it does not make it disappear.

The short version is:

> Axiom makes program control, authority checks, obligation accounting, and
> replay deterministic. It does not make an LLM or the external world
> deterministic.

## 2. Four-level determinism taxonomy

The word “deterministic” is often used for four different properties. Axiom
names them separately so a claim about one cannot be mistaken for another.
The levels are cumulative for a recorded execution, but Level 4 is an
environmental property rather than a Core guarantee.

| Level | Property | Same inputs mean | Core 0.1 status |
| --- | --- | --- | --- |
| **D1 — Artifact determinism** | Parsing, checking, lowering, canonical serialization, and hashing | The same accepted source bytes, migration sidecars, and pinned toolchain produce byte-identical canonical AIR and hashes | **Guaranteed under the stated assumptions** |
| **D2 — Control determinism** | Evaluation and state-machine behavior | The same verified AIR, task input, runtime policy, and ordered external outcomes produce the same bindings, obligation transitions, effect requests, and terminal result | **Guaranteed under the stated assumptions** |
| **D3 — Replay determinism** | Re-execution from an effect transcript | The same program, input, run identity, and valid complete ledger reproduce the recorded control path and terminal payload without live external calls | **Guaranteed under the stated assumptions** |
| **D4 — Live-world reproducibility** | Independent live executions | Separate calls return the same model answers, observations, timing, and side-effect receipts | **Not guaranteed** |

The levels should not be compressed into the sentence “Axiom makes agents
deterministic.” The defensible statement is:

> Axiom provides D1–D3 and exposes D4 variation as typed, bounded, recorded
> external outcomes.

### 2.1 D1 — Artifact determinism

For a pinned conforming toolchain `T`:

```text
compile_T(source_bytes, verified_sidecars) = AIR_bytes
```

repeated compilation produces the same canonical `AIR/0.1` bytes. Axiom's
canonical JSON domain:

- accepts only Unicode scalar-value strings and performs no implicit Unicode
  normalization;
- accepts only finite safe integers, rejects floating-point values and `-0`;
- rejects sparse arrays, accessors, cyclic values, and non-data object
  properties;
- rejects duplicate JSON keys at untrusted parsing boundaries; and
- serializes object keys in one defined scalar ordering.

Each compiled program has two different hashes:

- the **semantic program hash** binds executable records, propositions, ports,
  tasks, and operations while excluding authoring trivia and `sourceHash`; and
- the **artifact hash** binds the exact canonical AIR, including source
  provenance.

Consequently, formatting and comments may preserve the semantic hash while
changing the artifact hash. That distinction is intentional: replay effect
identity follows executable meaning, while review and release systems can bind
the exact artifact.

D1 does not mean that an unpinned future compiler version must emit the same
AIR. Language, AIR, protocol, compiler, and dependency versions must be
explicit compatibility inputs. `AXLOCK/0.1` records these versions, both
program hashes, every port signature, each task's inferred port set and static
bounds, and an optional exact host-binding fingerprint. Lock verification is
whole-object and fail-closed.

### 2.2 D2 — Control determinism

Let `E` be the ordered sequence of normalized external outcomes supplied at
declared effect sites. For accepted Core 0.1 AIR:

```text
execute(AIR, task, input, policy, E) = one Axiom transition transcript
```

The VM defines:

- immutable bindings and source-order operation execution;
- detached canonical input, binding, effect-argument, and ledger snapshots so
  caller mutation cannot rewrite already accepted runtime state;
- exact integer, string, list, record, equality, and built-in semantics;
- explicit read, model, validator, write, and verifier effect sites;
- nominal propositions and proposition-specific evidence;
- linear evidence consumption;
- `pending -> satisfied` obligation transitions;
- invalidation of satisfied `state` obligations after every `act`;
- stable, domain-separated write idempotency keys; and
- success only at `complete` after all obligations are currently satisfied.

The external outcomes in `E` may be nondeterministic. D2 says the runtime's
reaction to them is not. A model answer cannot change which operation executes
next in certified Core 0.1, add a port, mint evidence, or reinterpret task
source.

Core 0.1 has no certified loop, recursion, concurrency, dynamic evaluation, or
dynamic task generation. Every accepted task has a finite operation sequence
and one final `complete` or `fail`. Each `infer` site has positive byte and
attempt bounds. Live external invocations also have host deadlines, although a
deadline cannot undo an external side effect that already happened.

### 2.3 D3 — Replay determinism

A live run records:

- semantic and artifact program hashes, source hash, task, input hash, and run
  identity;
- trusted binding-set identity, optional implementation fingerprint, and model
  adapter identity;
- every normalized effect intent and its success or failure outcome;
- raw and normalized model protocol responses and request hashes;
- obligation transitions and world epochs; and
- the terminal success or failure payload.

Ledger entries are canonical and hash chained. Durable ledgers are opened
without overwrite, append the intent before invoking an effect, flush each
append, and record an outcome afterward. A crash between intent and outcome is
therefore visible as an uncertain effect rather than rewritten as “nothing
happened.”

Every caught write failure is also conservatively recorded with
`uncertain: true`: a timeout or transport error cannot prove that a remote
write did not commit. Reads and other non-write failures record
`uncertain: false`. Reconciliation remains a host responsibility.

Replay:

1. validates the ledger shape and hash chain;
2. checks the program, task, input, and run header;
3. requires each current effect request to match the next recorded request;
4. reparses recorded raw model output and checks it against its normalized
   envelope;
5. rejects missing, extra, reordered, or mismatched effects; and
6. compares obligation transitions and the terminal payload.

No model, tool, validator, or verifier is called during replay. This gives an
exact deterministic account of what Axiom did with the recorded outcomes.

A ledger hash chain provides tamper evidence only when its root is anchored
outside the attacker's control. An attacker able to replace an entire ledger
can recompute an internally valid chain. Core 0.1 does not yet sign, encrypt,
remotely timestamp, or transparency-log ledger roots.

### 2.4 D4 — Live-world reproducibility

Axiom does not promise that two independent live runs produce the same `E`.
Variation may come from:

- stochastic model sampling or nondeterministic inference kernels;
- model, weights, tokenizer, routing, moderation, or provider revisions;
- adapter retries, provider failures, and network timing;
- files, services, databases, users, clocks, and other agents changing;
- tool implementations with hidden state;
- scheduling and host failures; or
- verifier observations taken at different external states.

Temperature zero, a seed, a model name, and a content hash are useful controls,
not proofs of identical live behavior. A provider may not implement a seed
identically across versions, and an external service can change even when the
model does not.

Deployments that need reproducible tests should use fixture bindings. Those
that need reproducible audits should retain the ledger and replay it.
Deployments that need live-world consistency must add domain mechanisms such
as snapshots, versioned reads, conditional writes, transactions, or consensus.

## 3. The successful-completion guarantee

For an accepted Core 0.1 program:

```text
Run(program, task, input) = Complete(value)
```

implies all of the following:

1. every obligation declared by that task exists in the runtime obligation
   table;
2. every obligation is in `satisfied` state at completion;
3. each satisfaction consumed verifier-minted evidence for the exact nominal
   proposition required by that obligation;
4. the same evidence value was not consumed twice; and
5. evidence for a `state` proposition was created in the current world epoch,
   after the most recent Axiom `act`.

There is no `skip`, “best effort success,” warning-only requirement, or model
message that can substitute for `satisfy`. `assert` and `fail` terminate
unsuccessfully. If an inference, effect, validator, or verifier fails, the task
does not silently complete.

This is a **syntactic and operational proof-carrying guarantee**. Whether a
proposition expresses the right real-world requirement, and whether its
trusted verifier tests it correctly, are separate questions.

## 4. Candidate confinement guarantee

Every model result is introduced as `Candidate<T>`, even when it matches the
declared output schema. Schema conformance proves shape, not authority or
truth.

The checker, strict AIR verifier, and VM enforce that a candidate:

- cannot be stored in a record or task result;
- cannot participate in deterministic expressions;
- cannot control an assertion or action idempotency key;
- cannot be passed to a tool, model, or verifier;
- cannot be returned by `complete`; and
- may flow only as a top-level candidate argument to a declared validator.

Only trusted validator code can return an ordinary `T`. A validator may reject
the value or apply grounding, path, policy, size, and capability checks before
that value reaches an effect.

This guarantee prevents direct authority laundering through model output. It
does not prove that a validator is complete, honest, bug free, or isolated
from the privileges of its host process.

## 5. Effect and evidence guarantees

### 5.1 Declared effects

Only declared external ports are callable:

| Operation | Required port | Meaning |
| --- | --- | --- |
| `observe` | `tool ... mode read` | Obtain a typed external observation |
| `infer` | `model` | Obtain an untrusted candidate |
| `validate` | `validator` | Narrow a candidate through trusted code |
| `act` | `tool ... mode write` | Request a typed external change |
| `verify` | `verifier ... proves P` | Ask trusted code to establish `P` |

The source checker and independent AIR verifier both check port kind,
arguments, result types, immutable destinations, and operation-site ordering.
The VM re-verifies AIR before execution.

The language does not currently sandbox a trusted binding implementation. A
binding function can use any authority available to its host process. Least
authority is inferred and lockable at the language level, but operating-system
or service-level enforcement remains a deployment responsibility.

### 5.2 Write identity

Every `act` supplies a user key. The runtime derives the key presented to the
host from:

```text
semantic program hash
+ task
+ input hash
+ operation node
+ user key
+ argument hash
```

This prevents accidental collision across different programs, tasks, inputs,
sites, or arguments. It does not itself make a remote API idempotent. The host
adapter must persistently deduplicate that key, including after crashes and
restarts.

### 5.3 Evidence

Evidence is not accepted as ordinary JSON input and cannot be returned by an
external port. The VM mints an internal evidence identity only after the
declared verifier returns acceptance. Evidence is nominal, linear, and tied to
the current world epoch for `state` propositions.

This prevents a model or tool from forging evidence by returning an
evidence-shaped object. A dishonest verifier is inside the trusted computing
base and can still assert a false proposition.

## 6. Markdown migration guarantee

The Markdown importer makes a deliberately narrow claim:

> No nonblank imported span may silently disappear between the embedded source,
> the `AXMAP/0.1` coverage map, and strict compilation.

It preserves exact source bytes, byte ranges, span hashes, and categories.
Every nonblank span begins unresolved and blocks strict compilation. A
reviewer must either:

- link the span as a requirement to a real task obligation; or
- mark it non-normative with a nonempty reason.

A source-wide review seal binds the complete source hash and canonical set of
dispositions. Editing the document, a span anchor, a linked proposition, or a
review decision invalidates the seal.

This proves complete, content-bound disposition coverage. It does **not** prove
that:

- the reviewer understood the prose;
- a linked formal obligation is semantically equivalent to the prose;
- a non-normative classification is correct;
- the reviewer's identity is authentic; or
- prose was internally consistent or possible to satisfy.

Signatures, code ownership, independent review, and domain validation are
needed for high-assurance migration.

## 7. Model independence

### 7.1 What is independent

Axiom language semantics contain no model-vendor name, tokenizer, SDK,
chat-role format, sampling parameter, native tool-calling protocol, or
provider-specific response object. A normalized AXIP request contains typed
node-local input, compact schemas, intent, active obligation identifiers,
allowed response kinds, and portable byte and attempt limits.

A provider adapter maps:

```text
normalized AXIP request -> normalized AXIP outcome
```

The outcome is a candidate, a declared context request, or a structured
failure. Core 0.1 currently enables candidates and failures and rejects context
requests explicitly.

Changing a model or adapter cannot change:

- AIR and its operation ordering;
- declared obligations or their propositions;
- tool read/write modes;
- validator or verifier authority;
- idempotency-key derivation;
- byte and attempt limits;
- completion rules; or
- replay validation.

The minimum conceptual provider can exchange finite UTF-8 text. Native JSON
schema, native tool calling, a system role, prompt caching, and a known
tokenizer are optional adapter optimizations rather than language semantics.

### 7.2 What is not independent

Model independence is **portability of the boundary**, not equivalence of
capability or output. Models may differ in:

- whether they can follow the intent or output schema;
- candidate correctness, safety, bias, and quality;
- latency, price, refusal behavior, and context capacity;
- tokenization and provider-side byte overhead; and
- repeatability across attempts.

A weaker model may exhaust its bounded attempts and cause visible failure.
A stronger model may return a better candidate. Neither gains additional
authority.

The adapter is also part of the trusted boundary for faithful transport. The
conformance probe checks framing, typed output, identity echoing, limits, and
nonce preservation; it is not remote attestation, a quality benchmark, or a
proof that a provider honors an advertised model identity.

### 7.3 Portable efficiency

There is no model-independent token unit. Axiom therefore uses UTF-8 bytes as
the normative portable limit and treats provider token counts as telemetry.
The runtime sends only the current inference site's evaluated inputs,
reachable schemas, active obligation IDs, and declared references; it does not
send the entire task or execution transcript.

This architecture makes prompt cost measurable and usually smaller. It does
not guarantee a fixed token count, cost, or latency across model families.

## 8. Explicit non-guarantees

Core 0.1 does not guarantee:

- that every human intention was declared as an obligation;
- that contradictory, impossible, underspecified, or subjective requirements
  can be completed;
- that a model understands the intent or returns a useful candidate;
- that two live model calls return the same bytes;
- that a schema-valid candidate is safe without an adequate validator;
- that tools, validators, verifiers, adapters, the compiler, or the VM are
  honest or free of bugs;
- that a host binding is confined to its declared port authority;
- that an external write is atomic, transactional, reversible, or
  exactly-once merely because it has an idempotency key;
- that external changes not performed through this VM invalidate state
  evidence;
- that a timeout cancels work already executing in another process or service;
- that a hash-chained ledger is authentic or confidential without external key
  management;
- that a package hash proves source provenance or freedom from supply-chain
  compromise;
- that Markdown migration proves semantic equivalence;
- that Core 0.1 is a security sandbox; or
- that the language alone constitutes AGI.

## 9. Claim checklist

Documentation, papers, benchmarks, and release notes should use the strongest
applicable claim from this table and no stronger one.

| Claim | Acceptable? | Required evidence |
| --- | --- | --- |
| “Accepted source compiles canonically under a pinned toolchain.” | Yes | D1 conformance tests and exact toolchain version |
| “Axiom prevents successful completion with a declared unresolved obligation.” | Yes | Checker, AIR-verifier, and VM invariant tests |
| “Given recorded external outcomes, Axiom control is deterministic.” | Yes | D2 transition and property tests |
| “This run can be replayed without the original model.” | Yes, for a valid complete ledger | D3 replay verification |
| “Axiom is model-vendor independent at the protocol boundary.” | Yes | AXIP conformance plus the limitations above |
| “Axiom makes any model deterministic.” | No | Impossible at the language boundary |
| “Axiom guarantees the task is correct because it completed.” | No | Requires correct specifications and trusted verifiers |
| “No harness is needed.” | No | The Axiom runtime is the standardized harness |
| “Axiom is currently safe for arbitrary untrusted plugins.” | No | Core 0.1 is not an OS or service sandbox |

The honest launch promise is:

> Axiom replaces repeatedly interpreted instruction prose with a typed,
> fail-closed, proof-carrying execution contract. It standardizes the harness
> around a model; it does not claim to remove computation, trust, or
> nondeterminism from the world outside that contract.
