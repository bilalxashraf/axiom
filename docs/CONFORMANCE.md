# Conformance and verification

Conformance is not one boolean. Axiom separates language implementation,
canonical artifact, runtime/replay, model-adapter, and release-pipeline checks.
Passing an adapter probe does not certify an Axiom compiler, and passing the
compiler tests does not establish model quality.

The TypeScript package is the current reference prototype. It does not yet
operate a certification service. It does ship the first frozen, versioned
golden vector at `spec/conformance-vectors.json`; that vector is a precise
interoperability anchor, not a complete certification corpus.

## 1. Local verification

A clean checkout requires Node.js 24 or newer. The lockfile-based baseline is:

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` performs a no-emit TypeScript check, builds the package, and
runs every compiled test under Node's test runner.

The focused commands are:

```sh
npm run typecheck
npm run build
npm test
npm run repo:check
npm run test:determinism
npm run coverage
npm run package:verify
npm run vectors:generate
```

Their current meanings are:

| Command | Check |
| --- | --- |
| `npm run typecheck` | TypeScript type-check with no emitted files |
| `npm run build` | Compile source and tests into `dist/` |
| `npm test` | Rebuild and run every `dist/test/*.test.js` test |
| `npm run repo:check` | Check local documentation links, release-version alignment, required artifacts, and full-SHA action pins |
| `npm run test:determinism` | Rebuild and run `determinism.test.js` |
| `npm run coverage` | Run all tests with line 78%, branch 75%, and function 85% floors |
| `npm run package:verify` | Build, pack twice, compare archive bytes, inspect contents, install the archive, and smoke-test the API and CLI |
| `npm run vectors:generate` | Print the vector candidate derived from the current implementation; it never overwrites the frozen vector |

`package:verify` proves repeatability for two packs in the same environment. It
is not, by itself, a proof that every npm implementation and operating system
will emit the same tarball.

The property and mutation corpus sizes are configurable:

```sh
AXIOM_PROPERTY_CASES=20000 AXIOM_FUZZ_CASES=25000 npm test
```

`AXIOM_PROPERTY_CASES` and `AXIOM_FUZZ_CASES` must each be an integer from 1
through 1,000,000. `AXIOM_FUZZ_SEED` may select the arbitrary-byte migration
seed from 1 through 4,294,967,295. Defaults are deliberately smaller for local
feedback.

## 2. What the current test suites establish

### Parser, compiler, and type system

The core tests cover parsing, immutable bindings, exact type matching, port
modes, candidates, validators, proposition-bound evidence, obligation
completion, state-evidence invalidation, idempotency keys, and deterministic
built-ins. Repeated compilation is checked byte for byte.

The strict AIR suite mutates valid compiler output and expects fail-closed
rejection of unknown or missing fields, duplicate declarations, invalid types,
wrong ports, forged candidates or evidence, invalid operation sites, broken
terminal flow, and invalid obligation transitions. A canonical hash is not
treated as a substitute for semantic verification.

### Canonical data and deterministic properties

The determinism suite currently checks:

- JSON values use finite safe integers only;
- strings contain Unicode scalar values, with no implicit normalization;
- object keys are ordered by Unicode scalar value;
- negative zero is normalized;
- duplicate JSON keys and noncanonical ledger lines are rejected;
- `Bytes` values use canonical base64;
- string length counts Unicode scalar values while `utf8_bytes` counts bytes;
- integer division must be exact and remainder semantics are explicit;
- repeated compilation produces identical canonical AIR bytes and hashes;
- comments and formatting preserve the semantic hash but change provenance and
  artifact hashes;
- canonical serialization is idempotent over a seeded generated corpus;
- object insertion order does not affect canonical bytes; and
- AXLOCK changes are detected.

The default canonicalization property run uses 2,000 generated values plus 500
insertion-order comparisons. CI stress raises the property count to 20,000.

### Seeded fuzz and fail-closed behavior

The fuzz suite currently exercises:

- up to 128 arbitrary bytes per case through Markdown import;
- exact byte-for-byte base64 recovery of every imported source;
- regenerated AXMAP coverage and source anchors;
- arbitrary printable text through the parser/compiler, accepting only a
  result or an Axiom/canonical-data error; and
- arbitrary UTF-16 strings through canonicalization, requiring either a stable
  canonical round trip or an explicit Unicode-scalar rejection.

The default is 2,000 cases per parameterized fuzz test. The scheduled stress
workflow sets 25,000.

These are deterministic, seeded mutation corpora. They complement, but do not
replace, coverage-guided native fuzzers, resource-exhaustion testing, or a
formal proof.

### Protocol, effects, and replay

The protocol tests cover exact AXIP framing, request and response budgets,
schema validation, run/node identity, allowed response kinds, duplicate-key
rejection, immutable adapter snapshots, prologue references, timeouts, and
fixture/replay request-hash matching.

Runtime and hardening tests cover durable write-ahead effect intent, bounded
ledger reads, hash-chain validation, missing or extra replay effects, raw AXO
reparsing, terminal-result comparison, binding provenance, and forged AIR.
CLI admission tests also prove that `run --lock` accepts an exact fixture
binding and rejects a tampered artifact lock before execution.

The Markdown suites verify lossless source retention, exact byte partitions,
content-bound resolution declarations, source-wide review seals, stale-anchor
failure, and required sidecar loading.

## 3. Adapter conformance

The package exports:

```ts
checkAdapterConformance(adapter, {
  nonce?: string,
  timeoutMs?: number,
})
```

It sends one bounded AXIP/1 instruction asking the adapter to preserve a nonce
and return a fixed typed record. It checks framing, identity echoing, input and
output schemas, byte/attempt budgets, and exact value preservation. The result
reports adapter/model identity, request hash, frame and response bytes, and
inline-versus-reference prologue mode.

For a direct AXIP HTTP endpoint:

```sh
npm run build
node dist/src/cli.js conform \
  --adapter-url http://127.0.0.1:8080 \
  --timeout-ms 30000
```

Add `--cached-prologue` only if that endpoint has installed the exact current
`AXIP_PROLOGUE_HASH`.

This probe is intentionally small. It does not certify general instruction
following, model determinism, safety, tool behavior, validator quality,
verifier soundness, remote cache integrity, or suitability for a workload.

## 4. GitHub Actions checks

The repository contains four workflows.

### `CI`

`.github/workflows/ci.yml` runs on every push, pull request, and manual
dispatch. Its matrix is:

- Ubuntu with Node 24;
- Ubuntu with Node 26;
- macOS with Node 24; and
- Windows with Node 24.

Every matrix entry installs the lockfile with lifecycle scripts disabled, runs
`npm run check`, and runs the focused determinism suite. Ubuntu/Node 24 also
enforces coverage floors, audits production dependencies at high severity, and
verifies the installable package.

### `Determinism stress`

`.github/workflows/determinism.yml` runs daily at 02:23 UTC and on manual
dispatch. It runs the complete tests with 20,000 property cases and 25,000 fuzz
cases across:

- Ubuntu, UTC, `C`;
- Ubuntu, Asia/Kolkata, `en_US.UTF-8`;
- macOS, America/Los_Angeles, `en_US.UTF-8`; and
- Windows, UTC, `en-US`.

This matrix detects accidental dependencies on operating system, time zone, or
locale. It does not claim to cover every JavaScript engine or architecture.

### `Security`

`.github/workflows/security.yml` runs for pull requests, pushes to `main`, a
weekly schedule, and manual dispatch. It performs high-severity dependency
review on pull requests, JavaScript/TypeScript CodeQL analysis, and an npm
audit. Repository features and permissions required by dependency review or
CodeQL must be enabled by the hosting organization.

### `Release artifact`

`.github/workflows/release.yml` runs for `v*` tags and manual dispatch. It
checks source and tests, packs twice and proves byte equality, retains that
exact smoke-installed archive, verifies that a tag equals `v` plus
`package.json`'s version, attests the retained archive's build provenance, and
uploads it. It never rebuilds a different archive after verification.

The workflow does not publish to npm or create a GitHub Release. Publishing is
a separate authorized action.

All third-party actions are pinned to full commit SHAs. Dependabot checks npm
and GitHub Actions dependencies weekly.

## 5. Frozen golden vectors

`spec/conformance-vectors.json` is an immutable
`AXIOM-CONFORMANCE/0.1` vector. The test suite regenerates its candidate under
a hostile time zone and locale and requires exact structural equality. It
freezes:

- Unicode-scalar key ordering, negative-zero normalization, canonical hashes,
  and representative canonical-data rejections;
- exact source, canonical AIR, source/semantic/artifact hashes, and AXLOCK;
- a fixed pure execution result, every AXLOG entry, and its ledger root; and
- exact AXIP payload, inline/reference frames, AXO candidate response, hashes,
  and UTF-8 byte counts.

This initial vector catches drift in the core serialization pipeline and gives
independent implementations a concrete target. It is not yet broad enough for
a third party to claim comprehensive conformance. The corpus must grow to
include at least:

- source bytes, exact canonical AIR bytes, source hash, semantic hash, and
  artifact hash;
- valid and rejected canonical-JSON edge cases, including Unicode key order,
  duplicate keys, depth, base64, and integer bounds;
- readable AXIP requests, exact inline and referenced AXF1 frames, semantic
  request hashes, valid AXO responses, and rejection vectors;
- exact AXLOCK objects, port/task hashes, and mismatch vectors;
- fixed-run fixture executions with exact AXLOG entries and trusted ledger
  roots;
- Markdown byte inputs, generated `.ax`, generated AXMAP, and stale-review
  rejection vectors; and
- accepted and rejected AIR mutations with stable error categories.

Golden vectors use fixed run IDs, inputs, fixture bindings, and all other
ambient values. Each vector must name the source-language, AIR, AXIP, AXLOCK,
and AXLOG versions it targets. Once published for a version, its expected bytes
must be immutable. A change to expected bytes requires an explicit
compatibility decision and usually a format or language version change—not an
unreviewed snapshot update.

Error prose is currently diagnostic rather than a compatibility API. Golden
rejections should primarily match structured error codes and acceptance versus
rejection unless a specification explicitly freezes message text.

## 6. Path for an independent implementation

A second implementation should proceed from the lowest-level deterministic
contracts upward:

1. Implement the JSON value domain and canonical serialization: safe integers,
   Unicode scalar strings, Unicode-scalar key order, depth bound, duplicate-key
   rejection, canonical base64, and SHA-256 domain separation.
2. Implement the `axiom 0.1` lexer, parser, and static checks from the grammar
   and language document.
3. Lower source into exact `AIR/0.1` shapes and produce canonical bytes,
   semantic hashes, and artifact hashes.
4. Implement a strict AIR verifier independently from the lowering code. It
   must reject unknown fields and re-establish types, immutable bindings,
   operation sites, terminals, and obligation/evidence flow.
5. Implement expression evaluation and the obligation state machine without
   external effects.
6. Add typed ports, AXIP/1 framing, bounded adapters, effect intents, ledger
   chaining, and replay matching.
7. Add AXMAP/0.1 provenance verification and AXLOCK/0.1 creation/verification.
8. Run the shared golden vectors, generated property corpus, adversarial AIR
   mutations, and differential executions against the reference package.

The second verifier or implementation should not deserialize directly into
trusted internal classes and assume that type construction made an artifact
valid. The untrusted JSON shape and every invariant must be checked.

For differential execution, use fixture adapters and fixed run IDs. Compare
canonical AIR, semantic request hashes, effect requests, obligation
transitions, terminal payloads, and ledger roots—not object insertion order or
diagnostic formatting.

## 7. What passing means

A useful conformance report states the exact scope:

```text
Source: axiom 0.1
AIR: AIR/0.1
AXIP: AXIP/1
AXLOCK: AXLOCK/0.1
AXLOG: AXLOG/0.1
Reference package: @axiom-lang/core 0.2.0
Golden corpus: AXIOM-CONFORMANCE/0.1
Host/runtime: <implementation and version>
```

Passing this repository's tests means that one build of the reference
prototype satisfies its current executable suite. It is evidence, not a
mathematical proof, a security audit, an AGI claim, or a guarantee that live
models return identical candidates.
