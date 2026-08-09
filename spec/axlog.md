# AXLOG/0.1

## Encoding

An AXLOG file is zero or more Axiom Canonical JSON objects, one per UTF-8 line,
with exactly one LF after every object, including the last. Blank lines, CRLF,
noncanonical JSON, invalid UTF-8, duplicate fields, and trailing data are
invalid.

Every entry has exactly:

```text
hash, kind, payload, previous, sequence
```

`sequence` begins at zero and increments by one. `previous` is
`sha256:genesis` at sequence zero and the prior entry hash afterward. `hash` is
SHA-256 over the canonical object containing `sequence`, `kind`, `payload`, and
`previous`, excluding `hash`.

Default reader limits are 64 MiB per file, 8 MiB per line, 100,000 entries, and
the canonical JSON depth limit. Implementations may select smaller documented
limits, never silently truncate.

## Replay state machine

A replayable log:

1. starts with exactly one `run`;
2. contains zero or more `obligation` entries and paired
   `effect_intent`/`effect` entries;
3. has no unknown kind; and
4. ends with exactly one `success` or `failure`.

The reference runtime acquires exclusive append authority over a new empty
output ledger for the duration of one execution. Other append, publication,
or close attempts fail while execution is active. Appending after `success` or
`failure` is always invalid.

An `effect_intent` payload has exactly `request`. Its following `effect`
payload has exactly `request` and `response`, and the two requests must be
canonically equal. Another intent before an outcome is invalid. A terminal log
with an unmatched intent represents an uncertain external effect and is not
replayable.

A live success response is `{ "ok": true, "value": ... }`. A caught live
failure is `{ "ok": false, "error": ..., "uncertain": boolean }`. The
reference runtime conservatively sets `uncertain` to true for every dispatched
write failure because it cannot know whether a remote system committed before
timing out or rejecting. Read, model, validator, and verifier failures set it
to false. Replay reproduces the recorded failure; it does not reinterpret
uncertainty as rollback.

The runtime also verifies run identity, request sequence, obligation
transitions, effect-tape exhaustion, and exact terminal payload.

## Durability

The reference CLI creates a new ledger with exclusive-create semantics,
appends the run header before effects, writes each complete line, and fsyncs
before returning from append. It refuses to overwrite an existing log.

Filesystem durability does not prove a remote side effect's outcome. The host
must reconcile an unmatched write intent or a write failure marked
`uncertain: true` using the stable idempotency key.

## Authenticity

The chain detects mutation only relative to a trusted root. Anyone able to
replace the entire file can construct a different valid chain. Deployments
claiming authenticity must protect the final root with a signature, MAC,
append-only trusted store, or transparency service. AXLOG/0.1 itself specifies
integrity, not signer identity.
