# Dynamic harnesses as Axiom programs

## 1. Premise

Every agent system has a harness: something selects prompts, invokes models,
calls tools, tracks state, retries failures, and decides when work is done.
Removing that mechanism is impossible; hiding it in ad hoc application code
only makes it harder to inspect.

Axiom's credible goal is therefore:

> Move harness policy into a typed, versioned, verifiable language and reduce
> the remaining host to a small runtime plus explicit adapters.

Core 0.1 standardizes a linear static harness; Core 0.2 adds sequential,
source-authored, bounded control to that static harness. This document sketches
a future runtime-generated graph extension. Nothing marked **Planned** is part
of certified Core 0.1 or 0.2, and the graph syntax and GAIR format are not yet
normative.

## 2. Current foundation versus planned extension

| Area | Current — certified Core 0.1 / 0.2 | Planned — dynamic harness profile |
| --- | --- | --- |
| Workflow shape | Finite source-ordered task body; Core 0.2 has recursive static bounds | Finite verified task DAG instantiated at runtime |
| Model authority | Produces opaque `Candidate<T>` | May propose `Candidate<TaskGraphProposal>`, never executable code directly |
| Candidate approval | Declared trusted validator | Graph-specific validation plus compilation, independent verification, and deployment policy |
| Control flow | Core 0.2 exhaustive sequential `if` and post-test `repeat max N`; no recursion, concurrency, or dynamic task generation | Runtime-proposed tagged branches, deterministic joins, finite fan-out, no unrestricted recursion |
| Capabilities | Closed declared port set; recursive task port set recorded in paired AXLOCK | Unforgeable scoped capabilities with monotonic parent-to-child attenuation |
| Budgets | Per-inference byte/attempt limits, host deadlines, recursive static task bounds | Hierarchical budget vectors reserved and consumed by graph, child, retry, and supervisor |
| Failure | Explicit task failure; no automatic supervisor | Typed failure channels and bounded declared supervision policies |
| Parallelism | None | Stable lanes, canonical result ordering, restricted write concurrency |
| Proof | Task obligations and linear verifier evidence | Scoped child obligations, proof promotion, join proof rules, graph-level postconditions |
| Audit | AXLOG/0.2 authenticates the full ordered effect/control/obligation transcript | Proposal, validation, graph hash, policy decision, schedule, supervision, and child ledgers |

Keeping these profiles separate matters. A dynamic feature should enter the
certified core only after its termination, authority, proof-flow, and replay
rules are independently checkable.

## 3. The only safe dynamic execution pipeline

A model-proposed harness must pass every stage below:

```text
Candidate<TaskGraphProposal>
             |
             v
    validate proposal
             |
             v
       TaskGraphSpec
             |
             v
       compile graph
             |
             v
    canonical Graph AIR
             |
             v
   independently verify
             |
             v
 deployment policy admit
             |
             v
    sealed executable graph
             |
             v
    supervised execution
```

In compact form:

```text
Candidate<TaskGraph>
  -> validate
  -> compile
  -> verify
  -> policy
  -> execute
```

No arrow may be skipped, merged into a model prompt, or implemented as
“execute the JSON if it looks reasonable.”

### 3.1 Propose — untrusted candidate

**Planned.** A declared model port returns a
`Candidate<TaskGraphProposal>`. The proposal is data, not Axiom source, AIR, a
closure, an object with methods, or a host callback.

A proposal should contain only a closed versioned vocabulary:

- stable node identifiers;
- references to predeclared task templates;
- typed literal or data-flow arguments;
- typed success and failure edges;
- requested capabilities and budget;
- bounded retry and supervision policies; and
- graph-level obligations and expected outputs.

It must not contain:

- new external port implementations;
- shell commands interpreted outside a declared tool;
- arbitrary source text to `eval`;
- URLs, file paths, or credentials treated as authority merely because they
  are strings;
- unbounded loops, recursive self-instantiation, or “repeat until satisfied”;
- wall-clock races such as “take whichever model answers first”; or
- a request to weaken a validator, verifier, policy, or inherited obligation.

Candidate confinement continues to apply. A proposal cannot affect control or
call a tool until trusted validation produces an ordinary graph specification.

### 3.2 Validate — semantic narrowing

**Planned.** A graph validator checks more than JSON shape. At minimum it must
establish:

- the proposal uses one supported graph schema version;
- every task template, port, type, proposition, and policy symbol exists;
- node IDs are unique and canonical;
- all edges are typed and target existing nodes;
- the graph is finite and within node, edge, depth, and fan-out limits;
- all requested capabilities are a subset of the proposal scope;
- all requested budgets are positive and within the proposal scope;
- every failure has an explicit destination or propagates;
- retries have exact maximum counts and error-class predicates;
- writes have idempotency-key derivations;
- no candidate reaches control, proof, or an effect before validation; and
- domain constraints such as path, tenant, repository, recipient, and data
  classification are satisfied.

The output is `TaskGraphSpec`, a closed immutable value. Validator identity and
implementation fingerprint are recorded. Different domains will need
different validators; there is no universal prompt that can replace them.

Validation is trusted and can fail. A failed proposal is not partially
executed, automatically repaired, or treated as permission to ask for more
authority.

### 3.3 Compile — deterministic lowering

**Planned.** A deterministic compiler lowers `TaskGraphSpec` to a canonical
graph IR, tentatively called `GAIR/0.1`.

Compilation:

- resolves every template and type reference;
- assigns stable operation and lane identities;
- expands declared supervisor state machines;
- computes exact static bounds or rejects the graph;
- infers the least port and capability set;
- makes every terminal and failure edge explicit;
- inserts no model-authored hidden prompt or default capability; and
- emits semantic and exact artifact hashes.

The same graph specification and pinned compiler must produce byte-identical
GAIR. Compilation is not validation by another name: it assumes validated
input but still rejects a value it cannot lower unambiguously.

### 3.4 Verify — independent proof check

**Planned.** A strict verifier treats GAIR as hostile, just as Core 0.1 treats
loaded AIR as hostile. It independently proves or checks:

1. **Closure** — every symbol, node, edge, type, port, and policy reference
   resolves exactly once.
2. **Finiteness** — the initial certified graph profile is acyclic and has
   explicit node, edge, depth, and fan-out bounds. A later bounded-cycle
   profile would require a separate semantics and proof.
3. **Type safety** — every edge and argument has the declared type.
4. **Candidate confinement** — candidate-tainted values cannot control graph
   selection, effects, proof, or completion.
5. **Capability safety** — every operation uses a capability present in that
   node's attenuated scope.
6. **Budget safety** — the worst-case graph cost fits the reserved parent
   vector.
7. **Obligation safety** — every success terminal on every reachable path has
   matching proof for all active obligations.
8. **Failure totality** — every failure either reaches a declared supervisor or
   becomes graph failure.
9. **Write safety** — every write has stable identity and satisfies the
   concurrency profile.
10. **Join determinism** — every merge has one defined value, error, evidence,
    and ledger ordering independent of scheduler timing.

The verifier should be independently implemented or derived from a mechanized
semantics before the dynamic profile is called certified.

### 3.5 Policy — deployment admission and attenuation

**Planned.** A structurally valid graph is not automatically authorized.
Deployment policy intersects four sets:

```text
effective authority
  = parent authority
  ∩ program-declared authority
  ∩ graph-requested authority
  ∩ deployment-policy authority
```

If the graph requests anything outside that intersection, admission fails. The
policy layer must never “helpfully” grant the missing capability.

Admission also checks:

- approved program and graph hashes;
- exact compiler, verifier, adapter, and binding fingerprints;
- task-template and package locks;
- model/provider and data-egress policy;
- tenant, repository, path, host, method, recipient, and environment scopes;
- total budget, write quota, and risk tier;
- review or human approval requirements; and
- signatures, expiry, revocation, and provenance.

The admitted artifact is a sealed executable graph binding GAIR hash, parent
run, policy hash, capability set, budget reservation, and trusted binding set.

### 3.6 Execute — supervised, never improvised

**Planned.** The scheduler executes only the sealed artifact. It may not add a
node, retry, fallback, model, tool, context item, or budget not present in the
artifact.

Execution records:

- candidate proposal and hash;
- validator, compiler, verifier, and policy identities and decisions;
- GAIR and sealed-graph hashes;
- parent and child scope identities;
- capability and budget reservations;
- stable node/lane starts and outcomes;
- effect intent/outcome pairs;
- proof transitions and promotions;
- supervisor decisions; and
- exact terminal result.

Replay consumes those outcomes using the same deterministic graph semantics.

## 4. Capability attenuation

### 4.1 Capabilities are authority, not names

**Planned.** A port name says what operation is intended; it is not sufficient
authorization. Runtime capabilities should be unforgeable handles with
structured restrictions, for example:

```text
repo.read(
  repository = "acme/service",
  revision = "sha256:...",
  paths = ["src/**", "test/**"]
)

repo.write(
  repository = "acme/service",
  branch = "agent/fix-123",
  paths = ["src/greeter.ts"],
  max_bytes = 16384
)

http.call(
  hosts = ["api.example.test"],
  methods = ["GET"],
  response_bytes = 1048576
)
```

Strings inside a model candidate never become capabilities. A trusted policy
maps validated resource selectors to handles.

### 4.2 Monotonic attenuation

For parent scope `S` and child `C`:

```text
Caps(C) subset-of Caps(S)
```

Attenuation may narrow:

- port set and read/write mode;
- resource, tenant, repository, branch, path, host, method, or recipient;
- allowed input/output schema;
- data-classification and egress rules;
- call, byte, write, and rate quotas;
- expiry and run identity; and
- which child scopes may be created.

A child cannot widen, transfer, serialize, or return a capability as ordinary
data. A supervisor cannot regain authority it attenuated unless the parent
already retained a separate capability and policy explicitly permits a new
child grant.

### 4.3 Binding enforcement

The runtime must pass only the handle for the current operation to an isolated
binding worker. The worker must not receive a process-global credential that
can access resources outside the handle. Service credentials should be minted
or scoped per capability wherever the external platform supports it.

This is a planned production requirement. The current Core profiles record a
closed port set but do not provide OS-level or service-level isolation.

## 5. Hierarchical deterministic budgets

### 5.1 Budget vector

**Planned.** Each graph scope reserves a finite vector such as:

```text
B = {
  graph_nodes,
  graph_edges,
  nesting_depth,
  fanout,
  operations,
  external_effects,
  writes,
  model_attempts,
  model_input_bytes,
  model_output_bytes,
  tool_input_bytes,
  tool_output_bytes,
  ledger_bytes,
  cpu_units,
  memory_bytes,
  wall_deadline
}
```

Portable deterministic counters are normative. Wall time is a liveness policy
whose observed expiration becomes a recorded external outcome; it is not a
cross-machine deterministic unit.

### 5.2 Reservation and consumption

For every parent scope:

```text
sum(reserved child budgets) + parent retained budget
  <= parent remaining budget
```

Rules:

- a child receives an explicit reservation before it starts;
- reservations and consumption only decrease available authority;
- a retry consumes a fresh attempt and effect allocation;
- failed or timed-out work does not refund already consumed effects or bytes;
- unused reservation may return only after the child reaches a recorded
  terminal state;
- supervisors use their own reserved budget;
- graph expansion consumes node, edge, depth, and compilation budget before
  execution; and
- integer arithmetic is checked and cannot overflow.

Static verification should use worst-case bounds. A graph whose upper bound is
unknown is not admitted to the certified profile.

### 5.3 Budget failure

Exhaustion produces a typed failure containing the exhausted dimension,
scope, consumed amount, and bound. It cannot be converted into success,
silently borrow from a sibling, or trigger an undeclared larger-model fallback.

## 6. Deterministic branching and joins

### 6.1 Stable lanes

**Planned.** Parallel branches receive stable lane IDs derived from the graph
hash and node identity, not from spawn or completion timing. Values, errors,
evidence, ledger segments, and child IDs are ordered by lane ID.

Scheduling may be concurrent for performance. Observable language results may
not depend on which worker finishes first.

### 6.2 Allowed join forms

The certified dynamic profile should begin with a small set:

- **`all`** — wait for every lane and return an ordered tuple of results.
- **`collect`** — wait for every lane and return ordered tagged successes and
  failures.
- **`select_by`** — evaluate every successful lane, apply a deterministic
  trusted score/key, and choose the minimum canonical `(key, lane_id)`.
- **`fold`** — apply a pure typed reducer in canonical lane order.

“First response wins,” scheduler-order append, timing races, and iteration over
unordered host maps should be forbidden. A future `quorum` must define the
member set, threshold, equality relation, tie-break, missing-member treatment,
and evidence merge without referring to arrival order.

### 6.3 Join proof state

At a join, proof state is not a Boolean OR. Safe baseline rules are:

- an obligation is satisfied after `all` only if the join contract says which
  lane owns it and supplies matching unconsumed evidence;
- evidence remains scoped and linear; two lanes cannot consume one evidence
  identity;
- a parent obligation is not satisfied merely because a child with a
  same-named obligation succeeded;
- child evidence is promoted only through a declared proof adapter or
  verifier whose output matches the parent proposition; and
- state evidence must refer to a compatible version/epoch at the join.

If lanes observe or mutate incompatible world versions, the join fails or
requires a domain verifier. The scheduler cannot pick the most convenient
proof.

### 6.4 Concurrent writes

Concurrent writes are the hardest case because canonical result ordering does
not make the external world deterministic.

The initial certified dynamic profile should serialize writes unless the
verifier can establish one of:

- resource scopes are disjoint;
- the operation is commutative and idempotent under a declared domain
  contract; or
- the external system supplies a transaction or deterministic conflict rule.

“Last writer wins,” completion-order commits, and best-effort rollback are not
deterministic semantics. Each write retains its own intent, idempotency key,
uncertain-outcome state, and reconciliation obligation.

## 7. Supervision

### 7.1 Explicit supervisor state machines

**Planned.** Every supervised child has typed states:

```text
created
-> admitted
-> running
-> succeeded(result, evidence)
-> failed(error)
-> uncertain(effect_ids)
-> cancelled(reason)
```

A supervisor policy is finite data compiled into the graph. It maps a child
state and exact error class to one declared action:

- propagate failure;
- retry the same sealed child with a fresh attempt ID;
- start a predeclared fallback with attenuated authority;
- request human approval and become blocked;
- execute a declared compensation task; or
- complete a declared degraded result whose own obligations are satisfied.

There is no catch-all “try something else” and no model-authored runtime
exception handler.

### 7.2 Bounded retry

A retry policy declares:

- maximum attempts;
- exact retryable error codes or categories;
- whether a new model candidate is permitted;
- budget reserved per attempt;
- stable attempt identities and idempotency behavior; and
- terminal behavior after exhaustion.

Backoff and wall-clock scheduling are recorded host policy. They cannot change
which result wins or expand authority. A timed-out write enters `uncertain`
until reconciled; it is not automatically retried as though it never ran.

### 7.3 Cancellation

Cancellation:

- stops scheduling new child operations;
- sends cancellation to active workers;
- records which effects were not started, in flight, completed, or uncertain;
- leaves already committed external effects intact; and
- triggers only declared reconciliation or compensation work.

Cancellation is not rollback. An external service may complete after the local
worker stops waiting.

### 7.4 Compensation

A compensation is an ordinary declared effectful task, not erasure of history.
It has:

- its own attenuated capability and budget;
- an idempotency key;
- obligations and verifier evidence;
- failure and uncertain states; and
- a ledger trail linked to the original effect.

The supervisor may report “compensated” only after those obligations are
satisfied. Some effects are irreversible and must be declared
non-compensatable.

### 7.5 Human escalation

Human approval is a typed external effect and evidence source. Waiting for a
human produces a visible blocked state, not success. Approval must bind the
exact graph hash, requested authority, budget, proposed effects, and expiry.
Free-form “looks good” text is not a transferable capability.

## 8. Dynamic proof and completion rules

**Planned.** A dynamic graph completes successfully only if:

1. its sealed GAIR and admission remain valid;
2. every node needed by the selected typed outcome is terminal;
3. no effect remains uncertain;
4. every graph and inherited obligation has current matching evidence;
5. every child budget and capability use is accounted for;
6. the deterministic join rules produce one result;
7. no supervisor action remains pending; and
8. the returned value matches the graph's declared output type.

Failure, cancellation, blocked approval, partial completion, degraded service,
compensation, and uncertainty are distinct tagged outcomes. They must not be
collapsed into a Boolean `done`.

## 9. Model independence and token efficiency

Dynamic orchestration does not require sending GAIR or the full parent history
to a model. Each inference remains node local:

- the proposal model receives the graph goal, available **descriptions** of
  task templates, requested constraints, and a proposal schema;
- execution models receive only the current typed node input, reachable
  schemas, active obligation IDs, and declared context references;
- capability handles, credentials, policy internals, unrelated graph nodes,
  and old candidate text remain outside the prompt; and
- content-addressed template, schema, and prologue references permit caching.

UTF-8 bytes remain the portable normative budget because tokenizers differ.
Provider token use is telemetry. A model that cannot create a valid proposal
within budget fails without changing the pipeline.

The proposal schema and GAIR semantics are provider neutral. Different models
may propose different graphs, but every accepted graph passes the same
deterministic validation, verification, policy, and execution boundary.

## 10. Replay and audit for dynamic graphs

**Planned.** A dynamic ledger should be a tree of content-linked scope logs.
The parent records each child's sealed graph hash and terminal root; each child
records its own canonical sequence. Parallel completion may be buffered, but
the committed parent join entry is ordered by stable lane ID.

Replay verifies:

- the original proposal and validation result;
- compiler, verifier, and policy fingerprints;
- exact GAIR and admission hashes;
- parent-to-child capability and budget attenuation;
- stable schedule decisions and lane ordering;
- child effect tapes and terminal roots;
- retry, fallback, compensation, cancellation, and escalation decisions;
- proof promotion and join state; and
- graph terminal payload.

Replay reproduces the recorded graph behavior. It does not rerun policy against
today's rules unless an auditor explicitly asks for a separate
“would-current-policy-admit?” analysis.

## 11. Certification gates

The dynamic harness profile should not be labeled certified until all of these
exist:

- a normative graph schema, type system, and operational semantics;
- canonical GAIR encoding and domain-separated hashes;
- a deterministic compiler and independent hostile-input verifier;
- a formal capability attenuation relation;
- checked worst-case budget arithmetic;
- proof-flow rules for every branch, join, retry, and supervisor transition;
- deterministic scheduler and ledger conformance vectors;
- crash/restart and uncertain-write recovery tests;
- isolated per-capability binding workers;
- differential implementations or a mechanized reference model;
- property, mutation, concurrency, and fault-injection testing; and
- an updated security review and threat model.

Until then, dynamic planning should be implemented outside the certified core
as a producer of a candidate static `.ax` program that is reviewed, compiled,
verified, locked, and executed as a separate run.

## 12. Design principles

The extension should preserve these rules:

1. **Models propose; runtimes decide.**
2. **Data is not authority.**
3. **Every authority is explicit, scoped, attenuated, and auditable.**
4. **Every retry and fallback is finite and budgeted.**
5. **Arrival order never defines semantic order.**
6. **Uncertain effects block success until reconciled.**
7. **Evidence is scoped, nominal, current, and single-use.**
8. **Generated graphs are verified artifacts, never evaluated text.**
9. **Failure remains visible and typed.**
10. **Dynamic behavior cannot weaken a static parent contract.**

That is the viable meaning of “the language is the harness”: orchestration
policy becomes portable Axiom semantics, while the small runtime, adapters,
isolation layer, and external systems remain explicit parts of the deployed
machine.
