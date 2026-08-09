# Compatibility and versioning

Axiom has several independently versioned boundaries. Treating “the Axiom
version” as one number hides important incompatibilities.

The current reference package is `@axiom-lang/core` 0.3.0. It accepts frozen
source language 0.1 and the Core 0.2 control profile, emits and verifies their
paired AIR, lock, and ledger formats, and speaks AXIP/1 for both.

## 1. Compatibility axes

| Axis | Current identifier | What it governs |
| --- | --- | --- |
| Package/API | `@axiom-lang/core` `0.3.0` | TypeScript API, CLI, implementation fixes, distribution |
| Source language | `axiom 0.1;`, `axiom 0.2;` | Grammar, typing, operations, obligation semantics |
| Executable IR | `AIR/0.1`, `AIR/0.2` | Exact lowered JSON shapes and executable meaning |
| Model protocol | `AXIP/1` | AXF1/AXO1 framing, compact schemas, budgets, outcomes |
| Lock format | `AXLOCK/0.1`, `AXLOCK/0.2` | Toolchain, program, capability, bound, and binding pinning |
| Ledger format | `AXLOG/0.1`, `AXLOG/0.2` | Run provenance, effects, control trace, and replay meaning |
| Markdown map | `AXMAP/0.1` | Lossless import coverage and disposition anchors |

Compatibility on one axis does not imply compatibility on another. An adapter
may support AXIP/1 without parsing Axiom source. A compiler may emit valid AIR
without implementing HTTP. A package update may preserve language syntax while
changing its public TypeScript types.

## 2. Current behavior is exact-version, not negotiated

The parser accepts exactly the two explicit source editions:

```axiom
axiom 0.1;
axiom 0.2;
```

The strict AIR verifier requires an exact paired format and language:

```text
0.1 <-> AIR/0.1 <-> AXLOCK/0.1 <-> AXLOG/0.1
0.2 <-> AIR/0.2 <-> AXLOCK/0.2 <-> AXLOG/0.2
```

Cross-pairs and unknown AIR fields are rejected. The AXIP decoder requires
the AXIP/1 magic lines, exact compact object keys, and exact fixed-prologue
hash. AXLOCK verification reconstructs the current lock and compares the
entire decoded object. There is no feature negotiation, “compatible mode,”
ambient latest edition, or best-effort downgrade.

This strictness prevents a newer producer from silently assigning an older
consumer a meaning it does not understand. It also means an upgrade must be
deliberate.

## 3. Three program hashes

A compiled program exposes three related identities.

### Source hash

`program.sourceHash` is SHA-256 of the exact source text supplied to the
compiler. Comments, whitespace, imported provenance declarations, and review
seals can change it. The filename is not part of this hash.

### Semantic program hash

`compiled.hash` is a domain-separated hash:

```text
domain = AXIOM-PROGRAM/0.1 or AXIOM-PROGRAM/0.2
value  = {
  format,
  language,
  records,
  propositions,
  ports,
  tasks
}
```

It excludes `sourceHash`. Formatting and comments that lower to the same AIR
semantics therefore preserve it. The VM uses this hash for run identity,
effect identity, inference requests, idempotency keys, and replay matching.

“Semantic” means the exact normalized executable representation under this
format. It is not a theorem prover for observational equivalence. Reordering
declarations or making a different normalized program that happens to return
the same value can still change the semantic hash.

### Artifact hash

`compiled.artifactHash` hashes the complete AIR object, including
`sourceHash`. It binds executable semantics to source provenance. The
compiler's `bytes` are the canonical JSON bytes of that object with no trailing
line feed. The CLI writes the same canonical JSON followed by one line feed for
a convenient `.air` text file; the line feed is not part of the object hash.

The practical choice is:

- use the semantic hash for execution and replay compatibility;
- use the artifact hash when exact source provenance matters; and
- retain the source hash to identify the authoring text.

AXLOCK records all three.

## 4. Source compatibility

Source compatibility asks whether a new toolchain accepts the same `.ax` text
and assigns it the same language-level meaning.

For the current prototype:

- language 0.1 remains accepted under its frozen linear rules;
- language 0.2 adds only exhaustive sequential `if` and bounded sequential
  `repeat`, under its named rules;
- there is no published long-term source-compatibility promise;
- package `0.x` releases may still contain breaking implementation/API changes;
- Markdown migration declarations are checked provenance and do not enter AIR
  executable arrays, though they affect the source and artifact hashes; and
- source acceptance alone is insufficient—compare emitted AIR and hashes when
  qualifying an upgrade.

A syntax addition that is unreachable in an old file may be source-compatible
for that file, but it is not automatically AIR-compatible. A changed typing,
evaluation, obligation, effect, or canonicalization rule is a semantic change
and must not be shipped as an invisible reinterpretation of `axiom 0.1`.

## 5. AIR compatibility

AIR compatibility asks whether a verifier and VM accept an artifact and assign
the same operation semantics.

`AIR/0.1` is a closed schema:

- the root and nested objects have exact keys;
- declaration order and operation order are retained;
- operation sites are checked;
- identifiers, types, ports, limits, terminals, and obligation flow are
  reverified; and
- a hash does not make otherwise invalid AIR trusted.

Because unknown properties fail, adding an AIR field is not a compatible
extension for existing `AIR/0.1` consumers. A producer that needs new
executable meaning should emit a new AIR format and a consumer should implement
an explicit verified conversion if lossless conversion is possible.

Loaded AIR carries `sourceHash`, but it does not carry the original source or
AXMAP sidecar. A consumer can verify the artifact and its hash; it cannot
reconstruct or independently review the original prose from AIR alone.

`AIR/0.2` is a separate closed schema. It adds recursive `if` and `repeat`
operations, preorder static sites, lexical control scopes, recursive bounds,
and a separate `AXIOM-PROGRAM/0.2` semantic-hash domain. An AIR/0.1 consumer
must reject it rather than ignoring control operations. An AIR/0.2 consumer
must continue to verify AIR/0.1 using the old linear rules.

## 6. AXIP compatibility

AXIP compatibility asks whether an adapter preserves the same normalized
inference request and outcome.

AXIP/1 fixes:

- `AXP1`, `AXF1`, and `AXO1` framing;
- compact request and response keys;
- compact schema encoding;
- request identity and output identity echoing;
- byte, token, and attempt budget positions;
- candidate, context-request, and failure outcomes; and
- the exact semantic prologue hash.

The semantic request hash covers the compact request payload and is independent
of inline-versus-referenced prologue transport. A cache optimization can
therefore preserve AXIP compatibility.

Changing a field's meaning, schema tag, response kind, budget interpretation,
or prologue semantics requires a new protocol version. An adapter must fail on
an unknown version rather than treating it as AXIP/1. The current source
profiles send no context references and do not implement a `need_context`
round even though the protocol can represent one.

## 7. Replay compatibility

Replay compatibility is stricter than “the program still runs.” A replay
requires:

- the same semantic program hash;
- the same task name;
- the same canonical input hash;
- the same run ID recorded in the source ledger;
- the same ordered external-effect requests;
- one recorded response for each intent;
- no missing or unused effects;
- matching raw and normalized model responses;
- the same obligation-transition transcript; and
- for AXLOG/0.2, the same full ordered effect/control/obligation transcript,
  including control-entry iteration vectors;
- the same terminal kind and canonical terminal payload.

The ledger reader also checks canonical JSON lines, sequence numbers, bounded
sizes, and the SHA-256 previous-entry chain. The chain detects mutation
relative to a trusted root; it is not a signature or proof of who produced the
log.

Comments and formatting can change the artifact hash while retaining replay
compatibility because effect identities use the semantic hash. A semantic hash
change intentionally breaks replay matching.

Replay preserves the source run's `trusted_bindings` provenance and makes no
live calls. It does not prove that those original bindings were honest, that a
host-supplied fingerprint named the claimed binaries, or that the ledger root
was independently anchored.

## 8. Behavioral compatibility

Behavioral compatibility asks whether users observe the same results and
effects.

For pure execution and replay, the intended invariant is:

```text
same verified semantic program
+ same task and typed input
+ same ordered recorded effect outcomes
= same Axiom state transitions and terminal result
```

For live runs, equal AIR is not sufficient. Model candidates, tool state,
validator/verifier implementations, adapter behavior, provider routing,
timeouts, host policy, and external failures can differ. AXLOCK can pin an
opaque host binding fingerprint and static program facts, but it does not make
live services deterministic.

The package version also matters when assessing a reference implementation:
two implementations can claim the same format and still contain different
bugs. Conformance vectors and differential tests are required in addition to
version strings.

## 9. Version and edition policy

The following is the compatibility policy for evolving the prototype. It
describes how changes beyond the implemented source editions 0.1 and 0.2
should be classified.

### Package versions

Use npm Semantic Versioning for the library and CLI surface. While the package
major version is zero, treat every minor upgrade as potentially breaking and
qualify it with the full conformance suite and regenerated lock comparison.
A patch must not intentionally change language or wire meaning.

### Source editions

Every source file must continue to select its edition explicitly in the
`axiom` header. There must be no ambient “latest” edition that changes an
unchanged file. A new edition is required for incompatible grammar, type,
evaluation, obligation, or effect semantics.

An implementation may support multiple editions, but must parse and check each
under its named rules. An edition migration tool should emit a reviewable
source diff; it must not silently rewrite during execution.

### Artifact and wire versions

Change the AIR, AXIP, AXLOCK, AXLOG, or AXMAP identifier whenever a consumer
needs new rules to assign meaning safely. Do not add ignored executable fields
to a closed older format. Converters must name both versions and fail if a
meaning cannot be preserved.

The domain-separation label for a semantic hash is part of its versioned
contract. A new semantic representation must not reuse
`AXIOM-PROGRAM/0.1`.

### Compatibility support

Old artifacts and logs should be handled by an explicitly versioned reader or
an offline migration tool. A new VM should never reinterpret an old artifact
under new semantics merely because its JSON can be deserialized.

No removal timeline or long-term-support window has been promised for this
pre-1.0 prototype. A production adoption should vendor or pin the exact
toolchain and conformance corpus it has qualified.

## 10. Upgrade procedure

For a controlled toolchain upgrade:

1. Keep the old package, lock, AIR, fixtures, and ledgers available.
2. Run the old and new conformance suites in clean environments.
3. Compile the same source with both and compare semantic hash, artifact hash,
   canonical AIR, port signatures, task hashes, and static bounds.
4. Replay representative old ledgers with the new implementation.
5. Run adapter conformance against every production adapter profile.
6. Review every changed hash or rejection; do not normalize it away as build
   noise.
7. Regenerate and approve AXLOCK only after the change is understood.
8. Roll out with old artifacts and replay readers retained for rollback and
   audit.

A preserved semantic hash with a changed artifact hash usually means
provenance-only source changes. A changed semantic hash means the executable
identity changed and requires full review even when a human expects equivalent
behavior.
