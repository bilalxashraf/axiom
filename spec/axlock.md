# AXLOCK/0.1

AXLOCK is canonical Axiom JSON that binds a deployment review to an exact
toolchain profile and program artifact.

The root has exactly:

```text
binding, format, ports, program, tasks, toolchain
```

`format` is `AXLOCK/0.1`.

`toolchain` records package name/version, Axiom language version, AIR version,
and AXIP version.

`program` records:

- `semantic_hash`: `AXIOM-PROGRAM/0.1`, excluding source provenance;
- `artifact_hash`: exact canonical AIR including `sourceHash`; and
- `source_hash`: exact `.ax` source hash recorded by AIR.

`binding` is either `null` or the exact trusted host binding-set ID and
lowercase SHA-256 implementation fingerprint. Production certification must
not use `null`.

Each port record contains its name, kind, and `AXIOM-PORT/0.1` signature hash.
Each task record contains:

- its `AXIOM-TASK/0.1` hash;
- the exact sorted port set inferred from operations;
- a static operation bound;
- a worst-case external-effect bound;
- a model-attempt bound; and
- a write bound.

Core 0.1 is linear and has no recursion or branch, so these bounds are finite
and compiler-derived. They do not replace byte, time, token, monetary, or
host-sandbox limits.

Verification constructs the expected lock from freshly verified AIR and an
explicit binding descriptor, then compares the entire canonical object.
Unknown fields, missing fields, a tool signature change, a comment-only source
change, a changed bound, or a changed binding fingerprint all fail.

AXLOCK/0.1 locks one artifact and binding contract. It does not yet resolve a
dependency graph because Core 0.1 has no import system. A later module lock must
add exact content hashes, an acyclic dependency graph, exports, compiler
build identity, and frozen/offline resolution without arbitrary build scripts.
