# Security policy

## Supported status

Axiom is an alpha research implementation. The 0.2 toolchain and Core 0.1
language receive security fixes on the main development line. There is no
production-stability or sandbox guarantee yet.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting feature when it is
enabled. If the project is mirrored somewhere without private reporting,
contact the maintainers through a private channel before publishing details.
Do not put an exploit, secret, unsafe tool binding, or vulnerable production
endpoint in a public issue.

Include:

- affected toolchain, language, AIR, AXIP, AXLOG, AXMAP, or AXLOCK version;
- the smallest reproducer;
- whether the issue crosses a `Candidate`, evidence, capability, obligation,
  budget, replay, or canonical-hash boundary;
- expected and observed behavior; and
- any known effect on external systems or sensitive data.

## Security boundary

The TypeScript runtime is not an operating-system sandbox. Extern tools,
validators, verifiers, and model adapters are trusted host code. Deployments
must independently enforce filesystem, network, secret, approval, identity,
rate, cost, and process isolation.

A hash chain is not an authenticity proof without a trusted external root. A
timeout does not undo a remote write. A schema-valid model output is not
semantically trusted. A Markdown review seal proves a content-bound
attestation exists, not that its reviewer was correct or honest.

See `docs/THREAT-MODEL.md` for the complete model and the blockers before 1.0.
