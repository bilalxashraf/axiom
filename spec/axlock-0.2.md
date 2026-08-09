# AXLOCK/0.2

AXLOCK/0.2 is the canonical deployment lock for Axiom Core 0.2 and
`AIR/0.2`. It preserves the AXLOCK/0.1 object structure while changing the
format, toolchain identity, semantic hash domains, and static-bound rules.
AXLOCK/0.1 remains the lock for frozen Core 0.1 artifacts.

## Canonical object

An AXLOCK/0.2 file is one Axiom Canonical JSON value, optionally followed by
one LF. It has exactly:

```text
format, toolchain, program, binding, ports, tasks
```

`format` is `AXLOCK/0.2`.

`toolchain` has exactly:

```text
name      = "@axiom-lang/core"
version   = "0.3.0"
language  = "0.2"
air       = "AIR/0.2"
protocol  = "AXIP/1"
```

`program` contains exactly the semantic program hash, artifact hash, and
source hash. Core 0.2 semantic hashing uses the domain
`AXIOM-PROGRAM/0.2`.

`binding` is either null or an object containing a nonempty bounded binding ID
and a lowercase SHA-256 fingerprint. Null means no host implementation was
pinned; it does not mean that arbitrary bindings are trusted.

## Ports

`ports` contains the exact declared port set, sorted by identifier. Each item
contains the port name, kind, and a signature hash over:

```text
domain = AXIOM-PORT/0.2
port   = canonical AIR/0.2 port declaration
```

Changing a port kind, mode, parameter, return type, proposition, or model
intent changes its signature hash.

## Tasks and recursive bounds

`tasks` is sorted by task name. Each task contains exactly:

```text
name
ports
operation_bound
effect_bound
model_attempt_bound
write_bound
task_hash
```

The task hash covers the canonical AIR task with domain `AXIOM-TASK/0.2`.

The `ports` list is the sorted union of ports appearing anywhere in the task,
including both conditional branches and every repeat body. It is an inferred
least static capability set; a live path may use only a subset.

Bounds are computed recursively with checked safe-integer arithmetic:

- a sequential block adds component bounds;
- an `if` contributes one operation plus the larger branch operation bound;
- branch effect, model-attempt, and write bounds are the component-wise
  maximum of the two branches;
- a `repeat max N` contributes one operation plus `N` times its body operation
  bound; and
- repeat effect, model-attempt, and write bounds are `N` times their body
  bounds.

An `infer` operation contributes one operation and its declared attempt count
to both effect and model-attempt bounds. `observe`, `validate`, and `verify`
each contribute one effect. `act` contributes one effect and one write.
Pure/control bookkeeping contributes no effect.

Core 0.2 admission rejects:

- a repeat maximum outside 1..1024;
- an inference attempt maximum outside 1..16;
- control nesting deeper than 16;
- a task operation bound above 1,000,000;
- a task effect bound above 1,000,000; or
- any checked bound calculation that exceeds the safe-integer range.

These are upper bounds for one admitted execution, not exact live-use
predictions. Model output bytes and task-wide byte spend remain governed by
the per-inference limits and runtime accounting described in the protocol;
AXLOCK/0.2 does not add aggregate byte fields.

## Verification

Lock verification parses canonical JSON, validates exact object structure,
recompiles or revalidates the selected artifact, reconstructs the complete
expected AXLOCK/0.2 object, and compares it canonically. A mismatch in format,
toolchain, program identity, port signatures, recursive capability set,
bounds, task hashes, or binding identity is fatal before task dispatch.

A host must not downgrade an `AIR/0.2` program to AXLOCK/0.1 or reinterpret an
AXLOCK/0.1 file using these recursive rules. The format pair is exact:

```text
axiom 0.1 -> AIR/0.1 -> AXLOCK/0.1
axiom 0.2 -> AIR/0.2 -> AXLOCK/0.2
```

## Limits

AXLOCK/0.2 locks one compiled artifact and one optional binding contract. It
does not provide signatures, revocation, dependency resolution, OS sandboxing,
remote-service capability enforcement, or proof that a fingerprint names the
reviewed implementation. Deployments must authenticate the lock and enforce
the admitted capability set at the host boundary.
