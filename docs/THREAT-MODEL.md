# Axiom Core 0.1 and 0.2 threat model

## 1. Status and security posture

This threat model covers the Axiom Core 0.1 and 0.2 compiler, strict AIR
verifier, VM, AXIP/1 model boundary, Markdown migration artifacts, paired
AXLOCK formats, and paired AXLOG ledgers.

Axiom is a research prototype and execution-control kernel. It is **not yet
a security sandbox**. Running untrusted bindings in a process with filesystem,
network, cloud, or credential access is outside the current security
guarantee.

The primary security objective is narrower:

> Untrusted model output must not silently alter control, acquire undeclared
> effect authority, forge proof, or complete a task while a declared
> obligation is unresolved.

This document assumes an attacker may fully control model output, content read
by tools, imported Markdown, task input, network responses, and any ledger file
that has not been externally authenticated.

## 2. Assets

The system protects, or should protect, the following assets:

1. **Program integrity** — the accepted source, canonical AIR, semantic hash,
   artifact hash, and task selected for execution.
2. **Instruction coverage** — the mapping from imported prose to explicit
   formal obligations or reviewed non-normative dispositions.
3. **Control integrity** — operation order, immutable bindings, terminal state,
   and the inability of candidates to become control decisions.
4. **Authority** — tool credentials, filesystem and network access, write
   capabilities, and the exact set of ports a task may invoke.
5. **Proof integrity** — proposition definitions, verifier identity, evidence
   identities, world epochs, and obligation state.
6. **Binding integrity** — the implementation of tools, validators, verifiers,
   and model adapters selected for a deployment.
7. **Data confidentiality** — task input, tool observations, candidates,
   context, provider prompts, credentials, and ledger contents.
8. **Audit integrity** — effect intent/outcome pairs, model raw responses,
   obligation transitions, terminal payload, and ledger root.
9. **Availability and cost** — bounded model calls, effects, bytes, ledger
   growth, CPU, memory, wall time, provider cost, and external write volume.
10. **Release and supply-chain integrity** — compiler/runtime dependencies,
    GitHub Actions, package archives, version tags, and build provenance.

## 3. Security principals and adversaries

### 3.1 Principals

- **Program author** defines formal tasks, ports, propositions, and
  obligations.
- **Migration reviewer** decides how imported prose maps into formal semantics.
- **Deployment policy owner** selects the AIR, lock, bindings, budgets, model,
  and allowed environment.
- **Axiom toolchain** parses, checks, compiles, verifies, executes, records, and
  replays.
- **Trusted bindings** implement tools, validators, and verifiers.
- **Model adapter** transports AXIP to a local or remote model.
- **Model** returns untrusted candidate or failure output.
- **External systems** hold files, services, databases, credentials, and other
  mutable state.
- **Auditor** verifies artifacts, locks, ledgers, and replay.

### 3.2 Adversary classes

This model considers:

- a malicious or compromised model;
- prompt injection embedded in tool data or task input;
- a malicious program author or imported Markdown document;
- a careless or malicious migration reviewer;
- a compromised adapter, tool, validator, verifier, compiler, VM, dependency,
  or CI runner;
- an attacker who can edit source, AIR, lock files, ledgers, fixtures, or
  release artifacts;
- a remote service that equivocates, retries, races, or lies about results;
- another actor changing external state between observation and use; and
- an attacker attempting denial of service or cost amplification.

## 4. Trust boundaries

| Boundary | Untrusted side | Trusted side | Current check |
| --- | --- | --- | --- |
| Markdown migration | Arbitrary prose bytes | Reviewed Axiom declarations | Exact embedded bytes, `AXMAP/0.1`, per-span hashes, unresolved blockers, source-wide seal |
| Source to compiler | `.ax` text and task input | Typed AST and compiler checks | Strict grammar, types, immutable names, obligation flow |
| AIR load | Arbitrary JSON-like artifact | Certified Core 0.1/0.2 AIR | Exact paired format, shapes, types, recursive control/sites/bounds, evidence checks, hashes |
| Model boundary | Provider and generated text | `Candidate<T>` only | AXIP framing, identities, schemas, byte/attempt limits, candidate confinement |
| Binding boundary | Host implementation | Typed normalized effects | Port kind, argument/result type, deadlines, recorded intent/outcome |
| Write boundary | Remote mutable system | Recorded action receipt | Domain-separated idempotency key; host deduplication required |
| Verifier boundary | External observations and verifier code | `Evidence<P>` | Named verifier, exact proposition, VM-minted identity, linear consumption, world epoch |
| Ledger storage | Filesystem and operator | Replay transcript | Canonical lines, limits, hash chain, exact effect/control/terminal replay |
| Deployment selection | Program, package, bindings | Approved deployment | Edition-paired AXLOCK exact hashes, recursive capabilities/bounds, optional binding fingerprint |
| Release pipeline | Repository and dependencies | Published archive | Lockfile install, tests, determinism stress, package verification, pinned Actions, CodeQL, provenance attestation |

The compiler, strict AIR verifier, VM, canonicalization and hashing code,
cryptographic library, selected bindings, host process, and deployment policy
remain in the trusted computing base.

## 5. Security invariants currently enforced

### 5.1 Fail-closed instruction accounting

- Every task obligation starts pending.
- Only matching verifier evidence can satisfy it.
- Evidence is nominal and single-use.
- Every Axiom write invalidates previously satisfied `state` obligations.
- `complete` is rejected while any obligation is pending or stale.
- There is no skip operation.

### 5.2 Candidate confinement

- Models receive no direct tool handle or credential from the Axiom protocol.
- Model output is strict AXIP text and schema checked.
- Schema-valid output remains `Candidate<T>`.
- Candidates cannot participate in expressions, assertions, idempotency keys,
  tool calls, verifier calls, or task results.
- Only a declared validator can convert a candidate into an ordinary typed
  value.

### 5.3 Artifact integrity

- Canonical data rejects duplicate keys, ambiguous numeric values, invalid
  Unicode scalar strings, cycles, accessors, and unexpected object shapes.
- AIR has an executable semantic hash and an exact artifact hash.
- The VM independently verifies AIR and checks both hashes and canonical bytes.
- The paired AXLOCK freezes toolchain versions, hashes, port signatures, inferred
  task port sets, static operation/effect/model/write bounds, and an optional
  binding fingerprint.

### 5.4 Effect accountability

- External calls occur only at declared operation sites.
- Write tools require an idempotency key bound to program, task, input, site,
  user key, and arguments.
- An effect intent is durably recordable before the external call.
- Success and failure outcomes are recorded.
- External calls have positive host deadlines and receive an abort signal.
- Replay checks every request before substituting the recorded response.

### 5.5 Bounded parsing and transport

- Model input/output bytes and attempts are finite and declared per site.
- HTTP adapter request material and response bodies have finite byte checks.
- Unmeasurable streaming or multipart bodies fail closed.
- Model and host effects have finite runtime deadlines.
- Ledger reads have byte, entry, and line limits.
- Core 0.1 has no loop. Core 0.2 permits only post-test repeats with literal
  maximum 1..1024, control depth at most 16, and task operation/effect bounds
  at most 1,000,000. Neither profile has recursion, concurrency, or dynamic
  evaluation.

### 5.6 Deterministic bounded control

- `if` requires an exact `Bool`, has an explicit `else`, evaluates once, and
  executes only one branch.
- `repeat` requires an effect-bearing body and a condition that depends on a
  body-local binding; a raw candidate cannot control either construct.
- Repeat-local bindings are refreshed per iteration and cannot escape.
- Dynamic effect identities include the active iteration path, preventing two
  intended loop writes from sharing one Axiom-derived key.
- AXLOG/0.2 records branch and loop results with complete iteration vectors;
  replay authenticates the full ordered effect/control/obligation transcript
  instead of trusting control entries as executable input.

## 6. Attack analysis

### 6.1 Prompt injection causes a model to call a tool

**Attack.** Tool output or task input tells the model to ignore instructions,
exfiltrate secrets, invoke a tool, mark work complete, or forge proof.

**Current mitigation.** The model receives a node-local AXIP frame, not a tool
handle. Its only accepted authority-bearing output is an untrusted candidate.
The VM, not the model, owns operation order and effect invocation. A model
cannot produce evidence or completion.

**Residual risk.** Injection can still influence a schema-valid candidate. A
weak validator may approve a harmful path, query, patch, or recipient. Secrets
deliberately included in the inference input are disclosed to the provider.
Trusted validators and data-minimization policy are essential.

### 6.2 Candidate laundering

**Attack.** Smuggle model data through a record, built-in, condition,
idempotency key, task result, or malformed AIR to bypass validation.

**Current mitigation.** Candidate types are opaque and restricted by the
source checker, strict AIR verifier, and runtime taint checks. Loaded AIR is
not trusted merely because it contains a hash.

**Residual risk.** The three implementations share code and can share a defect.
Native extensions, unsafe casts in a host, or future language features could
open a new flow. Differential testing and an independent verifier
implementation are not yet complete.

### 6.3 False or forged evidence

**Attack.** Return an evidence-shaped object, reuse evidence, satisfy the wrong
proposition, or use a pre-write state check after mutation.

**Current mitigation.** Only the VM mints internal evidence after a declared
verifier accepts. Evidence is proposition-specific and single-use. State
evidence carries a world epoch and is invalid after any Axiom `act`.

**Residual risk.** A compromised or logically incomplete verifier can accept a
false statement. Global epochs do not notice external changes made outside the
VM and do not close read-check-write races. Verifiers currently run with the
authority of their host process.

### 6.4 Silent Markdown instruction loss

**Attack.** Import tooling drops a sentence, classifies a requirement as
documentation, reuses a stale review after context changes, or links a
requirement to an unrelated obligation.

**Current mitigation.** Exact bytes are embedded and hashed; a compiler-derived
coverage map accounts for every nonblank span; unresolved spans block strict
compilation; reviewed dispositions are content bound; a source-wide seal binds
the complete disposition set and linked proposition metadata.

**Residual risk.** Coverage does not prove semantic equivalence or reviewer
honesty. Review seals are hashes, not identity signatures. A malicious author
can write a weak obligation or verifier that appears linked. High-assurance
migration needs authenticated review, two-person approval, and domain tests.

### 6.5 AIR or lock tampering

**Attack.** Change a port mode, inference limit, operation, source, task, or
binding after review.

**Current mitigation.** Exact AIR shape verification, semantic and artifact
hashes, task and port hashes, fail-closed whole-object lock verification, and
optional `run --lock` admission against the actual runtime binding fingerprint
before effects begin.

**Residual risk.** `axiom run` does not establish who approved a supplied lock,
and unlocked alpha-mode runs remain possible when `--lock` is omitted. An
attacker controlling both artifact and lock can replace both. Signatures, a
mandatory certified deployment mode, and protected trust roots are not yet
built into Core.

### 6.6 Duplicate or uncertain writes

**Attack.** A retry, crash, timeout, lost response, or two runners repeats a
non-idempotent write.

**Current mitigation.** Every action has a deterministic domain-separated key.
Durable logging can persist intent before invocation and refuses to overwrite
an existing journal. A missing outcome leaves an explicit uncertain intent,
and every caught write failure records `uncertain: true`.

**Residual risk.** Exactly-once behavior depends on persistent host-side
deduplication. A timeout aborts the local wait but cannot prove the remote
operation stopped. There is no distributed transaction between ledger and
remote service, no universal recovery protocol for uncertain effects, and no
automatic compensation semantics.

### 6.7 Replay or ledger forgery

**Attack.** Edit an effect result, remove a failure, reorder operations,
truncate the log, substitute another program, or fabricate a complete run.

**Current mitigation.** Canonical hash chain, strict entry schema, complete
terminal structure, header binding, intent/outcome pairing, request matching,
raw model-response reparsing, transition comparison, terminal comparison,
exclusive execution ownership of an empty output ledger, and terminal sealing.

**Residual risk.** Hash chains provide integrity relative to an authenticated
root, not authorship. An attacker replacing the whole file can recompute it.
The ledger is plaintext and may contain sensitive inputs, tool data, provider
responses, and errors. Core has no signatures, encryption, external root
anchoring, retention policy, or selective disclosure.

### 6.8 External state race

**Attack.** State changes after a verifier observes it but before completion,
or another actor changes state without an Axiom `act`.

**Current mitigation.** Axiom invalidates state evidence after its own writes.

**Residual risk.** The world epoch is local to one VM run. It is not a database
snapshot, lease, lock, revision, or consensus proof. High-value invariants need
versioned observations and conditional writes in the domain binding.

### 6.9 Resource exhaustion and cost amplification

**Attack.** Huge input, output, schema, ledger, recursive data, repeated
inference, slow adapter, hanging tool, or provider envelope consumes unbounded
resources or money.

**Current mitigation.** Finite Core task bodies, bounded Core 0.2 repeats,
safe-integer limits, per-inference bytes and attempts, adapter transport caps,
effect deadlines, canonicalization depth limits, CLI input limits, and ledger
read limits. Recursive task bounds are exposed in AXLOCK/0.2.

**Residual risk.** A host callback performing synchronous CPU work can block
the JavaScript event loop and defeat a timer. A timed-out remote call can
continue consuming resources. Live ledger writes, overall task wall time,
total task bytes, memory, and external service quotas are not yet one
atomically enforced budget vector. Process/container isolation is required.
An admitted loop can intentionally consume its full static bound, and the
effect-presence rule does not prove useful real-world progress on every path.
Deployment policy should select substantially smaller bounds than the profile
maximum for expensive or destructive ports.

### 6.10 Capability escalation

**Attack.** A task invokes an undeclared port or a declared binding uses broader
filesystem/network/cloud authority than the task should possess.

**Current mitigation.** AIR names a closed port set; each operation is checked
against it; AXLOCK records the exact task port set and signatures.

**Residual risk.** A JavaScript binding receives a port name but runs inside a
host process that may hold ambient authority. Language-level declaration does
not enforce OS, service, credential, path, host, tenant, or row-level scopes.
There are no unforgeable runtime capability objects or automatic authority
attenuation yet.

### 6.11 Adapter equivocation and model substitution

**Attack.** An adapter changes the normalized request, weakens limits, claims a
different model, repairs invalid output, or returns provider metadata that
cannot be verified.

**Current mitigation.** AXIP fixes request and response shapes, semantic
request hashes, byte limits, identity echoes, allowed response kinds, and
strict parsing. The conformance probe tests a bounded nonce-preservation case.
Adapter and reported model IDs are logged.

**Residual risk.** The adapter remains trusted transport code. The probe is not
remote attestation. A provider can route among model versions or lie about
identity. Provider-side cache claims and deterministic-seed claims are not
cryptographic evidence.

### 6.12 Supply-chain compromise

**Attack.** A dependency, compiler package, GitHub Action, CI runner, or release
tag injects code or publishes an untested artifact.

**Current mitigation.** Exact npm lockfile installation, TypeScript checks,
unit/property/fuzz/determinism tests, OS/runtime matrix CI, package-content
verification, dependency review, npm audit, CodeQL, full-commit Action pins,
release-tag checks, and build provenance attestation.

**Residual risk.** Hosted runners, npm distribution, Node.js, TypeScript, and
transitive build infrastructure remain trusted. An attestation proves how an
artifact was built, not that the source is safe. Reproducible independent
build comparison and signed maintainer release policy remain future work.

## 7. Residual launch blockers

A research-preview release can proceed with the limitations prominently
stated. The broader claim “safe universal replacement for agent instruction
files in production” should remain blocked until the following are closed.

### 7.1 Critical blockers

| Blocker | Required closure evidence |
| --- | --- |
| **No binding sandbox or enforced least authority** | Per-port capability objects; path/host/tenant scopes; execution in isolated workers or processes; denial tests proving undeclared filesystem, network, process, and credential access fails |
| **No authenticated deployment admission** | Signed source/AIR/AXLOCK; protected trust roots; `run` admission that requires an approved lock and exact binding fingerprint; rotation and revocation procedure |
| **No complete write-recovery protocol** | Persistent cross-process idempotency contract; uncertain-effect recovery state machine; adapter conformance tests for crash-before-call, crash-after-call, lost response, timeout, and retry |
| **Host timeout is not effect revocation** | Out-of-process effect workers with kill and resource limits; documented remote cancellation semantics; post-timeout reconciliation for writes |
| **Ledger lacks authenticity and confidentiality** | Signed or MACed externally anchored roots; encryption and key management; redaction/classification policy; retention and deletion controls; recovery tests |
| **Trusted verifier correctness is unevaluated** | Domain-specific verifier specifications, adversarial tests, code ownership, implementation fingerprinting, and independent review for every production proposition |

### 7.2 High-priority blockers

| Blocker | Required closure evidence |
| --- | --- |
| **Single implementation lineage** | Independent AIR verifier or mechanized reference semantics; differential conformance corpus across implementations |
| **No external-state consistency contract** | Versioned observations, preconditions/ETags, conditional writes, or transaction adapters for state propositions that require freshness |
| **Review seals lack authenticated identity** | Signed review attestations, reviewer policy, two-person approval for imported requirements, and provenance verification |
| **No unified runtime budget scope** | Enforced totals for operations, effects, writes, attempts, bytes, memory, ledger growth, and wall time; child-budget attenuation for future dynamic graphs |
| **Provider and binding identity are self-asserted** | Verified package digest for local bindings; deployment registry; provider attestation where available; explicit “unattested” status otherwise |
| **Secrets have no information-flow policy** | Secret labels, provider egress policy, frame redaction, non-logging fields, encrypted evidence references, and leakage tests |

### 7.3 Assurance work required before a stable security claim

- Publish a versioned normative specification and compatibility policy.
- Maintain grammar, checker, AIR verifier, and VM conformance vectors.
- Add coverage-guided parser, protocol, AIR, ledger, and migration fuzzing.
- Add mutation testing for every fail-closed invariant.
- Commission independent security review and publish findings.
- Define vulnerability disclosure, supported-version, patch, and release-signing
  policies.
- Establish reproducible release builds on at least two independent builders.
- Benchmark denial-of-service limits and retain worst-case resource envelopes.
- Treat every new control-flow or concurrency feature as a fresh proof and
  threat-model obligation.

## 8. Deployment guidance for the current prototype

Until the blockers above are closed:

1. Run only reviewed `.ax` or AIR artifacts and verify the edition-paired AXLOCK immediately
   before execution.
2. Use an exact, non-null binding fingerprint.
3. Put tools, validators, and verifiers in a minimal isolated process or
   container with per-port credentials.
4. Permit writes only to systems that persistently deduplicate Axiom's full
   idempotency key.
5. Treat an intent without outcome as an incident requiring reconciliation,
   never as safe automatic retry.
6. Keep model input free of secrets that the selected provider may not receive.
7. Encrypt ledgers at rest, restrict access, and externally anchor the final
   root.
8. Use fixtures and replay for tests; do not infer safety from repeated live
   model agreement.
9. Require independent review of proposition definitions, validators, and
   verifiers.
10. Represent production completion as evidence about declared propositions,
    not as proof that all unstated human expectations were met.

## 9. Security non-goals

Neither Core 0.1 nor Core 0.2 attempts to:

- sandbox arbitrary JavaScript or native binding code;
- prove a natural-language requirement equivalent to formal Axiom;
- prove an external service truthful;
- make remote writes atomic or reversible;
- guarantee model quality, alignment, availability, or repeatability;
- hide data already sent to a model provider;
- replace identity, access management, operating-system isolation, database
  transactions, key management, or supply-chain security; or
- infer the complete set of requirements a human forgot to declare.

These non-goals are not reasons to weaken the language boundary. They identify
the external controls a production deployment must compose with Axiom.
