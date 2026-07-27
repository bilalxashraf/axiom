# AXLOCK/0.1 program locks

`AXLOCK/0.1` freezes the program facts that a host should approve before
execution: toolchain profile, program identities, port contracts, inferred task
capabilities, finite static bounds, and an optional trusted binding identity.

It is an execution approval manifest, not a dependency resolver. It does not
replace `package-lock.json`, an operating-system sandbox, a signed release, or
the runtime ledger.

## 1. Creating and verifying a lock

After building the package:

```sh
npm run build
node dist/src/cli.js lock examples/fix.ax \
  --output axiom.lock \
  --fixtures examples/fixtures.json
```

Verify the same source and fixture binding:

```sh
node dist/src/cli.js verify-lock examples/fix.ax \
  --lock axiom.lock \
  --fixtures examples/fixtures.json
```

The commands also accept an `AIR/0.1` file:

```sh
node dist/src/cli.js lock fix.air --output axiom.lock
node dist/src/cli.js verify-lock fix.air --lock axiom.lock
```

For production bindings, supply one explicit ID and lowercase SHA-256
fingerprint:

```sh
node dist/src/cli.js lock fix.air \
  --output axiom.lock \
  --binding-id production-2026-07-28 \
  --binding-fingerprint \
  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

node dist/src/cli.js verify-lock fix.air \
  --lock axiom.lock \
  --binding-id production-2026-07-28 \
  --binding-fingerprint \
  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

`--binding-id` and `--binding-fingerprint` must appear together.
`--fixtures` cannot be combined with either. With none of those options, the
lock records `binding: null`.

For `.ax` programs derived from Markdown, normal AXMAP anchor requirements
still apply. `--map` can supply an additional explicit sidecar. A loaded `.air`
file cannot use `--map`.

The `lock` command emits one canonical JSON object followed by a line feed.
`verify-lock` rejects duplicate JSON keys and compares the complete decoded
object through canonical serialization. It therefore rejects unknown, missing,
or changed fields, while insignificant input whitespace or JSON key order is
not itself a mismatch.

## 2. Exact lock shape

The exported TypeScript shape is:

```ts
interface AxiomLock {
  format: "AXLOCK/0.1";
  toolchain: {
    name: "@axiom-lang/core";
    version: "0.2.0";
    language: string;
    air: string;
    protocol: "AXIP/1";
  };
  program: {
    semantic_hash: `sha256:${string}`;
    artifact_hash: `sha256:${string}`;
    source_hash: `sha256:${string}`;
  };
  binding: {
    id: string;
    fingerprint: `sha256:${string}`;
  } | null;
  ports: Array<{
    name: string;
    kind: "tool" | "model" | "validator" | "verifier";
    signature_hash: `sha256:${string}`;
  }>;
  tasks: Array<{
    name: string;
    ports: string[];
    operation_bound: number;
    effect_bound: number;
    model_attempt_bound: number;
    write_bound: number;
    task_hash: `sha256:${string}`;
  }>;
}
```

In the current toolchain, `language` is `0.1` and `air` is `AIR/0.1`. Ports and
tasks are sorted by name. Each task's port list is unique and sorted.

`createProgramLock` first checks that a `CompiledProgram`'s semantic hash,
artifact hash, and canonical bytes match its AIR object. A caller cannot create
a lock from a forged wrapper whose seals do not match.

## 3. Program identities

The three program fields serve different review decisions:

- `semantic_hash` binds the versioned executable AIR fields while excluding
  source provenance;
- `artifact_hash` binds the entire AIR object, including `sourceHash`; and
- `source_hash` is the exact source hash embedded in AIR.

Formatting or comments can preserve `semantic_hash` while changing the other
two. AXLOCK intentionally includes all three, so `verify-lock` treats even a
provenance-only source change as a lock change.

This is stricter than replay compatibility. Replay uses the semantic program
hash so authoring trivia does not change effect identity.

## 4. Port contract hashes

Every AIR port is hashed as:

```text
canonicalHash({
  domain: "AXIOM-PORT/0.1",
  port: <complete AIR port object>
})
```

The complete object means a signature hash binds:

- port name and kind;
- tool read/write mode;
- ordered parameter names and types;
- return type;
- model intent; or
- verifier proposition,

as applicable to that kind.

The hash does not bind a tool binary, network endpoint, API credential,
provider model revision, validator source, or verifier implementation. Those
belong in the host-supplied binding fingerprint.

## 5. Inferred least-authority port sets

For each task, the lock scans executable operations and collects the port named
by every:

```text
observe
infer
validate
act
verify
```

The resulting `ports` array is the exact sorted set used by that task's AIR.
Operations such as `satisfy`, `assert`, `complete`, and `fail` add no external
port.

This is static least authority at the Axiom port-name level. A host can compare
the set to deployment policy before constructing runtime bindings. It is not
an operating-system capability system: one bound function could still access
more files, network destinations, or subprocesses than its Axiom signature
reveals. The host must sandbox and scope the implementation.

## 6. Static bounds

The lock records four nonnegative safe-integer bounds per task.

### `operation_bound`

The number of top-level AIR operations in the task. An `infer` is one
operation regardless of its retry count.

### `effect_bound`

The maximum number of Axiom external-effect dispatches implied by the
straight-line Core 0.1 task:

```text
observe  = 1
validate = 1
act      = 1
verify   = 1
infer    = declared attempts
```

Pure and obligation operations add zero. Counting all declared inference
attempts makes this an upper bound; a candidate may succeed before the final
attempt.

### `model_attempt_bound`

The sum of every inference site's declared `attempts`. It isolates the
nondeterministic model boundary from other effects.

### `write_bound`

The number of `act` operations. Each action carries a runtime-derived
idempotency key, but the bound itself counts declared action sites.

Bound addition is checked against JavaScript's safe-integer range. A task whose
inferred total overflows is not lockable.

These values count calls visible to the Axiom VM. They do not bound work
performed behind one tool call, provider-side retries, external fan-out,
latency, memory, ledger size, or damage from an overprivileged binding. Runtime
model and host-effect deadlines are separate policy.

## 7. Task hashes

Each task is hashed as:

```text
canonicalHash({
  domain: "AXIOM-TASK/0.1",
  task: <complete AIR task object>
})
```

The task hash binds parameters, return type, obligations, operation order,
sites, expressions, port names, inference limits, and terminals. The separate
capability and bound fields make important review facts directly visible; the
task hash detects every other task-object change.

## 8. Binding fingerprints

A lock binding has only two fields:

```json
{
  "id": "production-2026-07-28",
  "fingerprint": "sha256:..."
}
```

The ID contains 1–1024 Unicode scalar values. The fingerprint must be lowercase
`sha256:` followed by 64 hexadecimal digits. Axiom validates the shape but
deliberately does not prescribe how a production host computes it.

A useful production fingerprint should canonically cover at least:

- exact tool, validator, and verifier implementation artifacts;
- dependency lock and runtime image digest;
- port-to-implementation mapping;
- configuration that changes validation or verification behavior; and
- model adapter implementation and routing policy when live behavior must be
  pinned.

The fixture path is concrete: `FixtureBindings` uses ID `fixtures` and computes
its fingerprint as the canonical hash of the entire fixture JSON, including
tool, model, validator, and verifier fixtures.

A fingerprint is a host assertion, not remote attestation. AXLOCK does not
inspect binaries, verify a signature, query a transparency log, or prove that
the host actually loaded the named implementations.

## 9. Verification behavior

`verifyProgramLock` recreates the expected lock from:

```text
freshly verified CompiledProgram
+ current hard-coded toolchain profile
+ supplied binding identity
```

It compares the whole expected and actual objects. A mismatch in any of these
areas fails:

- toolchain name or version;
- source language, AIR, or AXIP version;
- semantic, artifact, or source hash;
- binding ID or fingerprint;
- port order, membership, kind, or signature;
- task order, capability set, bound, or task hash; or
- any unknown or missing field.

Diagnostics identify common hash mismatches and otherwise report the combined
toolchain/binding/port/task category. The diagnostic is not a stable machine
diff format.

`run --lock path` and `frame --lock path` verify the lock against the freshly
verified program and the exact runtime binding ID and fingerprint before any
external effect or model frame is dispatched. When an HTTP adapter is used,
create and verify the lock with the same `--fixtures`, `--adapter-url`, and
`--cached-prologue` selection; those settings contribute to the composite
binding fingerprint.

The CLI deliberately does not search implicitly for a nearby lock. Omitting
`--lock` selects unlocked alpha-mode execution. Production admission should
require the flag (or call `verifyProgramLock` in-process), authenticate the
lock's origin, and refuse a null or untrusted binding. Merely placing
`axiom.lock` beside a program still enforces nothing.

## 10. What AXLOCK does not lock

AXLOCK/0.1 does not currently contain:

- package dependency graphs or registry integrity fields;
- task inputs, run IDs, model outputs, or tool responses;
- runtime timeout selections;
- environment variables, secrets, filesystem roots, or network policy;
- operating-system or container capabilities;
- concrete provider model IDs or sampling parameters as first-class fields;
- ledger roots or signatures;
- Markdown source bytes or AXMAP contents beyond the compiled source hash; or
- a signature over the lock itself.

Use `package-lock.json` and release attestations for package supply chain,
sandbox policy for host authority, AXMAP for imported-source coverage, and
AXLOG for run-specific effects and replay.

For a production approval chain, store the canonical AXLOCK as a reviewed,
signed artifact, verify its signature and trusted origin outside Axiom, call
`verify-lock` against the exact program and binding set, and only then execute.
