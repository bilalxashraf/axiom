# Research-preview launch playbook

Axiom 0.2.0 is ready to launch as a public **research preview** of Core 0.1.
It is not ready to launch as a production security boundary, a universal AGI
mechanism, or a promise that stochastic models return identical answers.

## Release position

The defensible launch statement is:

> Axiom replaces operational agent Markdown with a typed, checked execution
> program. It makes instruction accounting, effect authority, validation,
> evidence, completion, canonical artifacts, and replay deterministic around
> explicit model and external-world boundaries.

The launch must not claim:

- that Axiom makes an LLM's internal inference deterministic;
- that a runtime, adapter, sandbox, or trusted verifier is unnecessary;
- that every Markdown instruction can be translated to equivalent executable
  semantics without review;
- that every model can solve every typed inference;
- exactly-once remote writes without host-side idempotency; or
- production certification from the reference test suite alone.

## Before creating the public repository

The repository owner must supply facts that this source tree cannot invent:

1. Confirm the final organization, repository URL, maintainer identities,
   security-reporting channel, and whether `@axiom-lang/core` is an owned and
   available npm name.
2. Add `repository`, `homepage`, and `bugs` metadata to `package.json` only
   after those URLs exist.
3. Add a `CODEOWNERS` file naming real reviewers for compiler/runtime,
   protocol, security, specifications, and workflows.
4. Enable private vulnerability reporting, the dependency graph, Dependabot,
   CodeQL, and artifact attestations in the hosting organization.
5. Protect the default branch. Require the CI matrix, CodeQL, dependency
   review, and at least one qualified review for security-boundary changes.
6. Protect tags and the release environment. Use npm trusted publishing or
   another short-lived identity flow; do not store a long-lived publish token
   in the repository.

## Candidate validation

From a clean checkout with Node.js 24:

```sh
npm ci --ignore-scripts
npm run check
npm run coverage
AXIOM_PROPERTY_CASES=20000 AXIOM_FUZZ_CASES=25000 npm test
npm run package:verify
```

The expected local result is:

- repository metadata and local links valid;
- 108 tests passing;
- at least 78% lines, 75% branches, and 85% functions;
- frozen `AXIOM-CONFORMANCE/0.1` vectors unchanged; and
- two byte-identical npm archives, followed by an installed API/CLI smoke
  test.

An npm advisory query requires network access and sends dependency metadata to
the registry. Run it only in an approved environment:

```sh
npm audit --audit-level=high
```

## GitHub release flow

The checked-in workflows intentionally separate ordinary validation from
release authority:

1. Pushes and pull requests run the cross-platform CI matrix.
2. A daily matrix stresses deterministic properties across operating systems,
   time zones, and locales.
3. Security automation runs dependency review, CodeQL, and npm audit.
4. A `v*` tag runs the release workflow.
5. The release workflow builds two archives, proves they are byte-identical,
   smoke-installs one, retains that exact archive, checks the tag against
   `package.json`, attests it, and uploads it.
6. It does **not** publish to npm or create a GitHub Release. A maintainer must
   inspect the checks and authorize those external mutations.

For `0.2.0`, the release tag is:

```text
v0.2.0
```

Do not tag until the public metadata and protected release environment are
configured.

## Demo path

The launch demo should show both success and fail-closed behavior:

```sh
axiom check examples/fix.ax
axiom lock examples/fix.ax -o axiom.lock \
  --fixtures examples/fixtures.json
axiom run examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --fixtures examples/fixtures.json \
  --lock axiom.lock \
  --ledger run.axlog
axiom replay examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --ledger run.axlog
```

Also demonstrate `import-md` stopping at explicit unresolved spans. That is a
feature: launch material should never imply that guessed semantic conversion
is safer than visible review.

## Post-launch evidence to collect

Before calling any later release stable:

- run the corpus on at least two independent Axiom implementations;
- qualify at least two real provider adapters;
- publish frame-byte, provider-token, acceptance, validation, and task-success
  measurements instead of a token-savings slogan;
- run crash injection around every write-intent transition;
- commission an external security review;
- publish compatibility and governance commitments; and
- close the critical blockers in `THREAT-MODEL.md`.

The complete stable-1.0 gates remain in `ROADMAP.md`. A successful research
preview is permission to gather evidence, not permission to erase the trust
boundary.
