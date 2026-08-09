# AXLOG/0.2

## Scope

AXLOG/0.2 is the replay ledger for `AIR/0.2`. It preserves AXLOG/0.1 encoding,
effect-pairing, durability, and hash-chain rules and adds explicit sequential
control events. `AXLOG/0.1` remains frozen and does not admit the new event
kinds.

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
`sha256:genesis` at sequence zero and the prior entry hash afterward. `hash`
is SHA-256 over the canonical object containing `sequence`, `kind`, `payload`,
and `previous`, excluding `hash`.

Default reader limits remain 64 MiB per file, 8 MiB per line, 100,000 entries,
and the canonical JSON depth limit. Implementations may select smaller
documented limits, never silently truncate.

## Run and terminal structure

A replayable AXLOG/0.2 ledger:

1. starts with exactly one `run` whose payload declares
   `format: "AXLOG/0.2"`;
2. contains zero or more `obligation`, `branch`, and `loop` entries and paired
   `effect_intent`/`effect` entries;
3. contains no other entry kind; and
4. ends with exactly one `success` or `failure`.

The reference runtime acquires exclusive append authority over a new empty
output ledger for the duration of one execution. Other append, publication,
or close attempts fail while execution is active. Appending after `success` or
`failure` is always invalid.

The run header binds semantic and artifact program hashes, source hash, task,
input hash, run ID, binding provenance, and live/replay mode as defined by the
Core 0.2 runtime.

## Effect pairs

An `effect_intent` payload has exactly `request`. Its following `effect`
payload has exactly `request` and `response`, and the two requests are
canonically equal. Another intent before an outcome is invalid.

A live success response is `{ "ok": true, "value": ... }`. A caught live
failure is `{ "ok": false, "error": ..., "uncertain": boolean }`. Write
failures are conservatively uncertain because a remote system may have
committed before timeout or rejection. Read, model, validator, and verifier
failures use `uncertain: false`.

An unmatched write intent or uncertain write failure requires host
reconciliation using the stable idempotency key. It is not evidence of
rollback.

## Control entries

A `branch` payload has exactly:

```json
{"iterations":[],"site":0,"taken":"then"}
```

- `site` is a non-negative safe integer naming the static `if` site.
- `iterations` is the complete active outer-to-inner iteration path. It is an
  array of positive safe integers and is empty outside repeats.
- `taken` is exactly `"then"` or `"else"`.
- The entry is appended after the Boolean condition is evaluated and before
  the selected block executes.

A `loop` payload has exactly:

```json
{"iteration":1,"iterations":[1],"site":3,"until":false}
```

- `site` is a non-negative safe integer naming the static repeat site.
- `iteration` is a positive safe integer and is one-based.
- `iterations` is the complete active outer-to-inner iteration path and its
  final element must equal `iteration`.
- `until` is the exact Boolean result evaluated after that iteration's body.
- The entry is appended after the condition evaluation and before exit,
  continuation, or `AX2140` exhaustion failure.

Nested-loop and repeated-branch instances are disambiguated by their complete
iteration vectors, ledger order, and the dynamic node identities inside their
effect requests. The control payload deliberately avoids copying the rest of
the dynamic environment.

## Replay state machine

Replay:

1. verifies program, task, input, and run identity;
2. requires every next effect request to match the next recorded request;
3. supplies the recorded response instead of making a live call;
4. re-evaluates every verified `if` and `until` expression;
5. reconstructs the full ordered effect-intent, effect, obligation, branch,
   and loop transcript;
6. rejects any missing, added, reordered, or changed transcript entry;
7. requires effect-tape exhaustion; and
8. requires the exact terminal kind and canonical terminal payload.

Recorded control events are evidence for comparison, not instructions to the
VM. A changed ledger decision cannot make replay take a branch that the
verified program and recorded effects do not select.

## Durability and authenticity

The reference CLI exclusively creates a new journal, appends and flushes the
run header before effects, and fsyncs every complete canonical line before
returning from append. Local durability does not establish the outcome of a
remote write.

The hash chain detects mutation only relative to a trusted root. Anyone able
to replace the entire file can construct a different internally valid chain.
Deployments claiming authenticity must protect the final root with a
signature, MAC, append-only trusted store, or transparency service. AXLOG/0.2
specifies integrity, not signer identity or confidentiality.
