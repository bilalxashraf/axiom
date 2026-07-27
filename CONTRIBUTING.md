# Contributing to Axiom

## Development contract

Axiom's core promise depends on changes being spec-first and fail-closed. A
feature is incomplete until its grammar, static checks, AIR representation,
independent AIR verification, runtime semantics, canonical encoding, negative
tests, replay behavior, and compatibility effect agree.

Do not add an inference shortcut that lets a model:

- produce a trusted value without `Candidate<T>` and validation;
- mint evidence;
- call an undeclared port;
- widen a capability or budget;
- mark an obligation skipped; or
- decide that a task is complete.

## Setup

Use Node.js 24 LTS or a currently supported newer release and npm 11.12.1.

```sh
npm ci --ignore-scripts
npm run check
npm run coverage
npm run package:verify
```

The test suite has no network requirement and the package has no runtime
dependency.

## Change requirements

For language or AIR changes:

1. update `spec/grammar.ebnf` and the relevant normative specification;
2. add accepted and rejected conformance vectors;
3. make the source compiler and strict AIR verifier reject the same invalid
   states;
4. state source, AIR, AXIP, replay, and behavioral compatibility;
5. add deterministic property or mutation tests; and
6. update `CHANGELOG.md`.

For protocol changes, measure frame bytes and preserve strict identity,
schema, budget, and duplicate-key checks. For Markdown migration changes,
prove byte coverage and show that stale source and formal-semantics seals fail.

## Determinism review

Review every use of:

- locale-sensitive comparison;
- unordered iteration;
- clock, randomness, environment, filesystem, or network state;
- floating-point numbers;
- host regular expressions;
- concurrency or completion order;
- implicit defaults;
- retries; and
- error-message text used as data.

Nondeterminism is permitted only at a declared external boundary and must be
recordable and replayable. Tests should state a reproducible seed.

## Pull requests

Keep changes focused. Explain the invariant being added or preserved, the
trusted-computing-base impact, compatibility classification, and the tests that
would fail if the invariant regressed. All GitHub Actions checks must pass.

Do not commit `dist/`, package archives, live ledgers, credentials, or provider
responses containing sensitive data.
