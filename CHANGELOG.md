# Changelog

All notable toolchain changes are recorded here. Language, AIR, AXIP, AXLOG,
AXMAP, and AXLOCK versions evolve independently of the npm package version.

## 0.2.0 - 2026-07-28

### Added

- Domain-separated executable semantic hashes and separate exact AIR artifact
  hashes.
- `AXLOCK/0.1` plus `axiom lock` and `axiom verify-lock`, including exact port
  signatures, inferred task port sets, static bounds, and host binding
  fingerprints.
- Durable exclusive-create AXLOG journaling with fsync, pre-dispatch effect
  intents, strict bounded reads, uncertain-effect detection, and exact replay
  terminal/obligation transcript checking.
- Stable write idempotency keys independent of random run IDs.
- Deadlines and abort signals for tools, validators, and verifiers.
- Unicode-scalar Text semantics, scalar ordering and length, `utf8_bytes`,
  safe-integer-only canonical JSON, canonical RFC 4648 `Bytes`, bounded JSON
  depth, and a safe certified schema-pattern profile.
- Markdown review seals bound to complete formal executable semantics.
- Deterministic property, arbitrary-byte migration, Unicode, ledger, lock,
  deadline, and formal-seal regression suites.
- Frozen `AXIOM-CONFORMANCE/0.1` vectors covering canonical data, AIR hashes,
  AXLOCK, a pure AXLOG trace, and exact AXIP frames.
- Cross-boundary identifier and AXIP text limits with Unicode-scalar counting.
- Same-directory atomic publication for generated `.ax`, AXMAP, AIR, and
  AXLOCK files; every individual output is flushed before rename.
- Detached, deeply frozen runtime and ledger snapshots, including canonical
  in-memory normalization of negative zero.
- Pinned-SHA CI, determinism stress, security, and attested-release workflows.
- Clean prepack, reproducible archive verification, installed-package smoke
  tests, Apache-2.0 licensing, and launch/security documentation.

### Changed

- Package version is 0.2.0; the certified source language remains Core 0.1 and
  the executable representation remains AIR/0.1.
- Canonical object-key ordering is Unicode-scalar lexicographic order.
- `Json` numbers are safe integers; fractional/exponent source literals are
  rejected.
- `AXREVIEW-DISPOSITIONS/0.2` supersedes the earlier review digest.

### Compatibility

- Comment and formatting changes preserve semantic program identity but change
  source and AIR artifact identity.
- Old review seals and old effect-only ledgers do not satisfy the stricter
  certified 0.2 toolchain checks.

## 0.1.0

- Initial Core 0.1 parser, checker, AIR compiler/verifier, VM, AXIP adapters,
  candidate validation, proof obligations/evidence, state staleness,
  hash-chained replay, and fail-closed Markdown migration.
