# Axiom roadmap

## Implemented Core 0.2 control profile

- Exhaustive, exact-Boolean `if ... then ... else ...` owned by the VM.
- Post-test `repeat max N { ... } until ...;` with `N` capped at 1,024,
  effect-bearing bodies, body-local predicates, fresh iteration frames, and
  fail-closed `AX2140` exhaustion.
- Preorder AIR/0.2 sites, iteration-specific effect identities, recursive
  AXLOCK/0.2 bounds, AXLOG/0.2 control traces, depth 16, and one-million
  operation/effect admission caps.
- Frozen Core 0.1 source, AIR, lock, ledger, and conformance-vector support.

## Alpha exit

- Keep all four CI workflows green across Node 24/26 and Linux/macOS/Windows.
- Expand the published `AXIOM-CONFORMANCE/0.1` and
  `AXIOM-CONTROL-FLOW-CONFORMANCE/0.2` vectors into complete positive and
  negative corpora with multiple independent consumers.
- Add recovery tooling for interrupted paired `.ax`/AXMAP publication and
  incomplete AXLOG journals; individual generated files are already published
  with flushed same-directory atomic renames.
- Require a non-null binding fingerprint in a certified-production CLI mode.
- Configure a public repository URL, private security reporting, branch
  protection, CODEOWNERS, npm trusted publishing, and protected release
  environment.

## Richer language work

- Closed `variant` types, `Option<T>`, `Result<T,E>`, `Never`, and exhaustive
  `match`.
- Typed domain failures distinct from runtime defects; no ignored outcomes.
- Parameterized propositions bound to exact artifact digests.
- Copy/affine/linear logical resource modes for evidence, authority, leases,
  transactions, and delegated obligations.
- Scoped effect regions so writes stale only overlapping state evidence.
- Pure, total, always-on `requires` and `ensures` contracts.
- A canonical comment-preserving formatter.

## Modules and authority

- Content-addressed imports, explicit exports, acyclic resolution, exact
  checksums, frozen/offline mode, and no arbitrary build scripts.
- Unforgeable host-enforced capabilities for resource, operation, secret,
  approval, rate, spend, and delegation scope.
- A required signed binding manifest connecting source contracts to deployed
  implementations.
- Multi-axis `axiom compat` analysis.

## Deterministic orchestration

- Validated bounded task graphs proposed only as `Candidate<TaskGraph>`.
- Capability and budget attenuation from parent to child.
- Static cycle, node-count, spawn-depth, obligation-ownership, and
  effect-conflict checks.
- Deterministic fork/join with canonical node ordering; concurrent writes only
  when disjoint, transactional, or proven commutative.
- Supervision and reconciliation for uncertain external writes.

## 1.0 gates

- Normative typing/effect judgments and complete conformance corpus.
- An independently implemented AIR verifier, preferably memory-safe and
  outside the TypeScript codebase, with differential testing.
- Crash-injection tests around every effect transition.
- External security review and published remediation.
- At least two independent provider adapters passing the full conformance
  profile.
- A compatibility and governance commitment.

No roadmap stage promises identical live output from stochastic models. The
1.0 goal is identical checked semantics and replay for fixed inputs and effect
tapes, plus prevention of undeclared completion, authority, and trust flows.
