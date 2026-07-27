# Axiom Core 0.1 Operational Semantics

## 1. Scope

This document is the normative execution model for the certified linear Core
0.1 profile. The concrete grammar is in `grammar.ebnf`; AIR is independently
verified before this machine executes it.

Core 0.1 deliberately has no source branch, loop, recursion, concurrency,
dynamic loading, reflection, exception handler, or general evaluation
primitive. A task therefore has a finite operation sequence, and the sum of
all declared inference-attempt bounds is finite.

## 2. Machine state

A task state is:

```text
S = (pc, env, candidates, obligations, evidence, epoch, effects, ledger)
```

- `pc` is the next zero-based operation site.
- `env` maps immutable binding names to typed canonical values.
- `candidates` is the set of bindings tainted as model-produced.
- `obligations` maps each declared ID to `pending`, `satisfied`, or `stale`.
- `evidence` maps verifier-minted IDs to proposition, mode, epoch, and consumed
  state.
- `epoch` is a non-negative integer incremented by every successful `act`.
- `effects` is a live external boundary or a finite replay tape.
- `ledger` is the ordered semantic transcript.

Task parameters initialize `env`. Every declared obligation initializes as
`pending`. Bindings cannot be replaced.

## 3. Pure expressions

Expression evaluation is total or returns a stable runtime failure. It cannot
call a port. Values and equality use Axiom Canonical JSON.

- integer arithmetic is checked;
- `/` succeeds only for a nonzero divisor and an exact safe-integer quotient;
- `%` is `a - trunc(a / b) * b` and fails for zero divisor;
- Text ordering is lexicographic Unicode-scalar order;
- `len(Text)` counts scalars;
- `utf8_bytes(Text)` counts its canonical UTF-8 bytes; and
- `sort` is stable in the sense that canonically equal values retain no
  observable identity beyond their values.

Candidate-tainted values cannot enter pure expressions except as direct
arguments whose declared parameter is `Candidate<T>` on a validator port.

## 4. Operations

### `observe`

The named port must be a read tool. Arguments are evaluated and type-checked.
The VM records and flushes an effect intent, invokes or replays the port, checks
the response type, and creates one immutable binding.

### `infer`

The named port must be a model. The VM creates a node-local AXIP request from
the port intent, live arguments, reachable output schema, active obligation
IDs, and declared byte/attempt limits. Every returned value is bound as
`Candidate<T>`, never `T`. Protocol failure can retry only within the declared
attempt bound. A model cannot mint evidence, call tools, change `pc`, or
complete a task.

### `validate`

The named port must be a validator. A successful trusted validator may narrow
`Candidate<T>` to `T`. Shape validation alone does not grant semantic trust.

### `act`

The named port must be a write tool. The idempotency expression must be
validated `Text`. The effective key hashes semantic program, task, original
input, stable site, arguments, and author key; it does not depend on a random
run ID. An intent is durably recorded before dispatch. On a successful typed
receipt, `epoch` increments and all satisfied state obligations become
`stale`. Event obligations remain satisfied.

Exactly-once execution is not a language-only guarantee. A remote write that
ignores its idempotency key or abort signal can remain uncertain. Every caught
write failure is conservatively recorded with `uncertain: true`; a recorded
local error is not evidence of remote rollback.

### `verify`

Only the named verifier may mint `Evidence<P>`. State evidence records the
current epoch. A false verifier result is terminal failure.

### `satisfy`

Evidence must be unconsumed, prove the obligation's nominal proposition, and,
for state evidence, match the current epoch. It is then consumed and the
obligation becomes `satisfied`.

### `assert`

The expression must be validated `Bool`. False is terminal failure. Assertions
are always evaluated and cannot be disabled.

### `complete`

Every obligation must be `satisfied`; no candidate may flow into the result;
and the value must match the task return type. Otherwise completion fails.

### `fail`

Terminates with the declared literal reason. Core 0.1 has no catch operation.

## 5. Effects and replay

For each live effect, the transcript order is:

```text
effect_intent(request)
effect(request, outcome)
```

The first entry must be the run header and the last exactly one success or
failure. Replay verifies the program/task/input/run identity, every next
request, the obligation transition sequence, tape exhaustion, and the exact
terminal payload. It performs no live external call.

## 6. Conditional determinism theorem

For a fixed conforming language/runtime profile, semantic program, typed input,
effective host policy, and finite recorded effect tape, execution has at most
one accepted state transition at each site and therefore one terminal
transcript or explicit failure.

This theorem does not state that a live model, tool, clock, network, verifier,
or validator returns the same value on two invocations. Those values are the
recorded external tape on which replay determinism is conditioned.
