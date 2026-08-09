# Axiom Core 0.2 Operational Semantics

## 1. Scope and compatibility

This document is the normative execution model for Axiom Core 0.2 and
`AIR/0.2`. Core 0.2 preserves the Core 0.1 data, expression, port, candidate,
evidence, obligation, effect, and completion rules and adds two structured
control operations:

- exhaustive `if EXPR then { ... } else { ... }`; and
- bounded post-test `repeat max N { ... } until EXPR;`.

The frozen Core 0.1 grammar and semantics remain in `grammar.ebnf` and
`semantics.md`. A source header selects one edition; an `AIR/0.1` artifact is
never reinterpreted as `AIR/0.2`.

Core 0.2 still has no recursion, concurrency, dynamic loading, reflection,
exception handler, general evaluation primitive, unbounded loop, or dynamic
task generation.

## 2. Machine state

A task state is:

```text
S = (control, env, candidates, obligations, evidence, epoch,
     iteration_path, effects, ledger)
```

The Core 0.1 components retain their meanings. `control` is a stack of
source-ordered blocks and structured-control continuations.
`iteration_path` is the vector of one-based iteration numbers for all active
repeats, outermost first. It is empty outside a repeat.

Bindings are immutable. A control block has a lexical environment derived
from its parent. Bindings introduced in an `if` branch or repeat body are not
visible after that control statement. A repeat body receives a fresh lexical
binding frame on each iteration. Binding identifiers remain statically unique
across the task artifact even when their runtime frames do not overlap.

## 3. Expressions and typed control

Core 0.1 pure-expression semantics remain unchanged. Control expressions:

- are evaluated by the VM, never by a model;
- must statically have type `Bool`;
- cannot invoke a port;
- have no truthiness or coercion; and
- cannot contain or depend on `Candidate<T>`.

The runtime rechecks the exact Boolean result before selecting control. A
pure-expression failure is terminal and occurs before any operation selected
by that decision.

An external result may influence control only after it crosses its declared
typed boundary. Model output therefore requires a trusted validator to narrow
`Candidate<Bool>` to `Bool` before use in `if` or `until`.

## 4. Sequence

A task body and every nested block are ordered sequences. For a sequence
`[o0, o1, ..., on]`, the VM completely evaluates `oi`, including any external
effect outcome, before beginning `oi+1`. There is no implicit parallelism,
reordering, speculative branch execution, or effect batching.

`complete` is permitted only as a top-level task operation. `fail` may be the
final operation of an `if` branch, where it terminates the selected execution;
it remains forbidden in a repeat. The task contains exactly one top-level
terminal, and it is its final top-level operation. A nested block that does not
fail falls through to its enclosing sequence.

## 5. Exhaustive conditional

For:

```axiom
if condition then {
  then_operations
} else {
  else_operations
}
```

the VM:

1. evaluates `condition` exactly once in the parent environment;
2. requires the value to be exactly `true` or `false`;
3. appends one `branch` control entry with its static site and complete active
   iteration vector to `AXLOG/0.2`;
4. executes only `then_operations` for true or only `else_operations` for
   false; and
5. resumes the enclosing sequence after the selected block falls through.

The unselected block performs no evaluation and no effect. `else` is
mandatory so the source contains no implicit success or no-op branch.
The final operation of either branch may be `fail`; if selected, it terminates
the task and the enclosing sequence does not resume. `complete` cannot be
nested.

Branch-local bindings do not escape. When both branches continue, they must
leave every task obligation in the same abstract status. When one branch
fails, only the continuing branch contributes state to the enclosing
sequence. Pre-existing evidence on continuing paths is conservatively joined:
it is treated as consumed after the branch if any continuing branch consumes
it, and valid only if every continuing branch preserves its validity. These
rules prevent a later operation from depending on which continuing branch
happened to retain authority or proof state.

## 6. Bounded post-test repeat

For:

```axiom
repeat max N {
  body
} until condition;
```

`N` is a source literal from 1 through 1024. The loop is post-test: `body`
executes once before the first condition evaluation.

For iteration `i`, beginning at one, the VM:

1. creates a fresh body-local frame;
2. appends `i` to `iteration_path`;
3. executes the complete body in source order;
4. evaluates `condition` while that iteration's locals are still visible;
5. removes `i` from `iteration_path`;
6. appends one `loop` control entry containing the static repeat site, the
   complete active iteration vector, `i`, and the Boolean result;
7. discards the body-local frame; and
8. exits on true, otherwise begins `i + 1` when `i < N`.

If iteration `N` produces false, the task fails with runtime code `AX2140`.
There is no hidden `N + 1` attempt, implicit backoff, exception catch, or
author-supplied exhaustion block.

The certified repeat profile additionally requires:

- a nonempty body;
- at least one declared external effect operation somewhere in the body;
- an `until` expression that references at least one binding introduced by
  the body and visible at the loop condition;
- no `verify`, `satisfy`, `complete`, or `fail` anywhere inside the repeat,
  including nested control; and
- at most 16 nested control constructs.

The external-effect and body-local-dependency checks make observed progress
explicit; they do not prove that the external world will eventually satisfy
the predicate. The literal maximum is the termination proof.

A caught external-effect failure terminates the task immediately. It is not
converted into a false condition and does not automatically retry the loop.
An `infer` operation retains only its own declared retry behavior, capped at
16 attempts per inference site in Core 0.2.

## 7. Dynamic effect identity

AIR operation sites are unique non-negative integers assigned by canonical
preorder traversal: visit a control operation, then its `then` and `else`
blocks, or its repeat body, before continuing the enclosing sequence.

For Core 0.2 the dynamic node identity is:

```text
Task:site@outer_iteration.inner_iteration:port
```

The `@...` segment is absent outside repeats. This identity is included in
effect requests. For writes it also enters the domain-separated effective
idempotency key. Re-executing the same recorded invocation therefore derives
the same key, while two intended writes at the same static site in different
iterations derive different keys.

Every successful `act` increments the world epoch and invalidates satisfied
state obligations and existing state evidence exactly as in Core 0.1.

## 8. Static admission and bounds

The compiler and independent AIR verifier recursively check exact object
shapes, preorder sites, lexical bindings, expression types, candidate
confinement, branch obligation joins, repeat restrictions, evidence flow, and
the single top-level terminal.

Worst-case task bounds use checked integer arithmetic. Let `B(block)` be the
component-wise sum of its operation bounds. Then:

```text
operations(if)     = 1 + max(operations(then), operations(else))
effects(if)        = max(effects(then), effects(else))

operations(repeat) = 1 + N * operations(body)
effects(repeat)    = N * effects(body)
```

Model-attempt and write bounds use the same branch maximum and repeat
multiplication. The inferred port set is the union of every statically
reachable branch and repeat-body port. Admission rejects a task whose
worst-case operation bound or effect bound exceeds 1,000,000. Overflow is a
verification failure, never saturation or wraparound.

`AXLOCK/0.2` records these recursive bounds. A bound is a worst-case admission
limit, not a prediction that every live run uses all permitted operations.

## 9. Effects, ledger, and replay

Every live effect retains the Core 0.1 write-ahead pair:

```text
effect_intent(request)
effect(request, outcome)
```

`AXLOG/0.2` additionally admits canonical `branch` and `loop` entries carrying
the complete active iteration vector. Replay
does not use those entries to choose control. It re-evaluates the verified AIR
from the typed input and recorded effect outcomes, emits its own control
trace, and requires the full ordered effect-intent/effect/control/obligation
transcript and terminal payload to match exactly. Missing, added, reordered,
or changed entries fail replay.

Repeated effects are matched using their full dynamic node identities, so a
recorded outcome from one iteration cannot be substituted for another.

## 10. Conditional determinism theorem

For a fixed conforming Core 0.2 implementation, verified semantic program,
typed input, effective host policy, run identity, and finite recorded effect
tape, sequence, branch selection, repeat count, obligation transitions, and
terminal behavior have at most one accepted transition at every step.

This theorem does not state that a live model, tool, validator, verifier,
clock, network, or remote write returns the same result in separate live runs.
Those external outcomes remain the recorded boundary on which replay
determinism is conditioned.
