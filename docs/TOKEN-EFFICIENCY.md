# Token and context efficiency

Axiom makes efficiency portable by budgeting UTF-8 bytes at the model boundary,
not by assuming that different models share a tokenizer. The `.ax` source is
compiled and executed by the runtime. It is not copied into every model call.
At an `infer` site, the model receives one bounded, node-local AXIP/1 frame.

This design reduces repeated context, but it does not make reasoning free or
guarantee that a smaller model will solve a task. Token counts remain useful
telemetry for one provider and model revision; they are not Axiom semantics.

## 1. Normative byte and attempt budgets

Every source-level inference declares three positive safe-integer limits:

```axiom
infer raw_plan = planner(input)
  limit input_bytes 16384 output_bytes 4096 attempts 2;
```

They lower into the AIR inference operation as:

```text
limits.inputBytes
limits.outputBytes
limits.attempts
```

For each attempt, the runtime constructs an AXIP request with:

```text
maxInputBytes  = input_bytes
maxOutputBytes = output_bytes
maxAttempts    = attempts
maxTokens      = input_bytes
```

The current Core 0.1 and 0.2 source languages have no provider-specific token-limit
syntax. `maxTokens = input_bytes` is therefore a conservative adapter-facing
placeholder, not a statement that one byte equals one token. A provider adapter
may impose a stricter token cap. It may not expand the byte or attempt limits.

`maxInputBytes` covers the complete UTF-8 AXIP frame: the inline or referenced
prologue, the `AXF1` marker, and the compact JSON payload. `maxOutputBytes`
covers the complete raw response, including `AXO1` and its JSON payload.
Encoding fails before dispatch if the input frame is too large. Output parsing
fails if the response is too large. Neither path truncates, summarizes,
repairs, or retries with weakened data.

The generic adapter boundary measures the AXIP text. `HttpTextAdapter` also
measures the endpoint, merged headers, and encoded HTTP request body before
`fetch`; it rejects request bodies whose finite size cannot be established.
Provider-envelope overhead may have a separately configured finite transport
allowance, but the decoded AXO text must still satisfy `maxOutputBytes`.

The limits are per attempt. A site with `attempts 3` can send at most three
frames, each within its declared byte bounds. AXLOCK records the worst-case
attempt bound for each task. AXLOCK/0.2 uses branch maxima and multiplies
inference attempts inside `repeat` by its literal bound, but neither source
profile declares one task-wide byte quota.

Byte bounds limit space, not latency. Live model attempts have a separate
30-second host deadline by default, configurable through
`RunOptions.inferenceTimeoutMs` or `--inference-timeout-ms`.

## 2. What is included in a node-local frame

The VM derives an inference slice from the selected model port and the current
runtime state. It includes:

- the semantic program hash, run ID, and stable node ID;
- the model port's `intent`;
- only the evaluated arguments declared by that port;
- a closed input schema for those arguments;
- the declared output schema;
- only named record definitions reachable from the input and output types;
- every currently pending or stale task-obligation ID, sorted by ID;
- the allowed response kinds;
- byte, token, and attempt limits; and
- the fixed semantic-prologue reference.

It does not include:

- the `.ax` source or canonical AIR;
- source comments, Markdown provenance, or unrelated task bodies;
- unrelated record definitions;
- previous model prose or a chat transcript;
- tool receipts that are not explicit arguments to this inference;
- validator or verifier implementations; or
- authority to call a tool, satisfy an obligation, or complete a task.

This is structural slicing, not probabilistic prompt summarization. The port
signature decides which values and types are visible. If an author passes a
large object as one argument, Core 0.1 sends that whole value; it does not
silently remove fields.

The current VM sets `contextRefs` to an empty list and allows only `candidate`
and `fail`. AXIP/1 defines a `need_context` response and reference field for
future or other runtime profiles, but the current profiles do not yet provide a context
store, chunking algorithm, reference expansion, or follow-up context round.
A `need_context` response therefore fails visibly.

### 2.1 Control flow does not become prompt text

Core 0.2 control remains inside AIR and the VM. Neither the unselected branch,
the repeat body, its maximum, nor prior iteration transcripts are copied into
an AXIP frame. An inference inside a repeat receives only that site's declared
arguments, reachable schemas, active obligations, budgets, and dynamic node
identity. The iteration suffix distinguishes recorded invocations without
turning the whole loop into model context.

AIR stores a repeat body once rather than unrolling it `N` times. Runtime cost
can still multiply: an inference with `attempts A` inside `repeat max N` can
make at most `N * A` model attempts. AXLOCK/0.2 exposes that bound, and each
attempt retains its own input/output byte caps. This is bounded cost, not free
cost.

## 3. Compact AXIP encoding

The public request API uses descriptive names. The text wire uses stable short
keys:

```text
r p n o i u x g a b c d h
```

Schemas also use compact scalar tags and tagged arrays. For example, an integer
is `"i"`, a list is `["a", item]`, a closed record is
`["o", [[field, schema], ...]]`, and a named record reference is
`["r", name]`. Definitions are emitted once per frame and only when reachable.

Wire JSON is canonical and has no indentation. This gives stable bytes and
hashes; it is not intended to be the most compressed possible representation.
AXIP/1 deliberately uses JSON rather than a binary codec so plain text models
and provider APIs can interoperate without a vendor-specific transport.

The semantic request hash is computed from the compact payload. It is
independent of whether the prologue was transported inline or by reference.
Fixtures and replay adapters can therefore use one stable lookup key for both
transport forms.

## 4. Prologue caching

AXIP/1 has one fixed semantic prologue exported as `AXIP_INLINE_PROLOGUE`. Its
content hash is `AXIP_PROLOGUE_HASH`.

The safe default is inline transport:

```text
AXP1
<fixed prologue>
AXF1
<compact request>
```

An adapter may advertise that the exact prologue is already installed by
including its hash in `cachedPrologueRefs`. The VM then sends:

```text
AXP1 @sha256:...
AXF1
<compact request containing the same h reference>
```

AXIP/1 accepts only the exact exported prologue hash. The preamble reference
and payload reference must match, and both forms decode to the same semantic
request. The CLI's `--cached-prologue` option makes this advertisement for the
HTTP adapter. It does not upload the prologue, inspect a remote KV cache, or
prove that the provider honored the cache. Cache installation and integrity
remain part of the trusted adapter configuration.

The implementation's efficiency test verifies that the referenced frame is
smaller and has the same semantic request hash as the inline frame.

The frozen `AXIOM-CONFORMANCE/0.1` example makes that invariant measurable:
its inline frame is 1,329 UTF-8 bytes and its referenced frame is 543 bytes,
a 59.1% transport-byte reduction with the same request payload hash. This is
an interoperability fixture, not a universal token-savings benchmark.

## 5. Measurements already emitted

Each recorded model effect identifies its attempt in the logical request. A
successful transport response records:

- `request_hash`;
- `frame_bytes`;
- `response_bytes`;
- adapter ID;
- provider model ID when supplied;
- provider-reported `input_tokens` when supplied; and
- provider-reported `output_tokens` when supplied.

Missing token telemetry is recorded as `null`; it is not estimated with a
different tokenizer. The normalized request in the effect record also contains
the declared budgets, schema, obligation IDs, and prologue reference.

Useful aggregate metrics can be derived from an `.axlog`:

- total and percentile frame bytes per inference site;
- total and percentile response bytes;
- attempts per accepted candidate;
- schema/protocol failure and retry rate;
- validator acceptance rate;
- bytes per successful task;
- inline-versus-reference frame-byte difference; and
- provider token counts, compared only within the same tokenizer revision.

`frame_bytes` measures the AXIP frame, not every byte a provider bills after
its SDK adds chat envelopes or internal control tokens. HTTP transport
accounting is stricter for budget enforcement, but that transport-size value is
not currently a separate ledger metric.

## 6. Reproducible benchmark method

The repository provides correctness tests, not a published cross-model
performance leaderboard. A defensible benchmark should keep task, input,
model, model revision, sampling configuration, adapter, and success criteria
fixed, then compare at least these profiles:

1. the complete Markdown instruction document sent on every call;
2. an inline-prologue Axiom frame;
3. a referenced-prologue Axiom frame after a verified cache warm-up; and
4. repeated Axiom calls at different nodes in the same task.

For every profile, report:

```text
request UTF-8 bytes
response UTF-8 bytes
provider input/output tokens, if available
attempt count
schema-valid candidate rate
validator pass rate
task success rate
latency
```

Byte savings for one matched request can be reported as:

```text
1 - (axiom_frame_bytes / baseline_prompt_bytes)
```

Do not report byte savings as token savings unless the exact provider tokenizer
was also measured. Do not compare cost while omitting failure rate: an
extremely small prompt that never produces an acceptable candidate is not more
efficient.

Local checks for the implemented efficiency invariants are:

```sh
npm ci --ignore-scripts
npm test
node --test dist/test/efficiency.test.js
```

After `npm run build`, the CLI can expose the actual frames for a fixture-backed
program:

```sh
node dist/src/cli.js frame examples/fix.ax \
  --task Fix \
  --input examples/input.json \
  --fixtures examples/fixtures.json
```

Add `--cached-prologue` only when the selected adapter endpoint has installed
the exact current prologue. The bundled fixture adapter does not advertise that
cache through this CLI flag.

## 7. Limits of the efficiency claim

Axiom currently guarantees bounded, measurable transport, not minimum token
count.

- The model port `intent` is still natural language and may be misunderstood.
- A large input value or deeply connected record graph can still make a large
  frame and fail its byte budget.
- Canonical JSON is stable and interoperable, but not as compact as a binary
  encoding.
- AXIP/1 has no schema-reference cache; reachable definitions are repeated in
  each relevant frame.
- the current profiles have no implemented content chunker or context-reference resolver.
- The source-level byte limits are per attempt, not a task-wide cost budget.
- Provider token accounting, hidden prompts, cache billing, and tokenizer
  revisions remain provider-specific.
- Prologue-reference mode trusts the adapter's cache claim.
- Retries improve availability at a multiplicative byte and token cost.
- Live model output remains nondeterministic; a small frame does not make two
  live calls identical.

The portable promise is therefore:

> Axiom sends a finite, typed, node-local request under enforceable UTF-8 byte
> and attempt limits, and makes the cost visible without depending on one
> model's tokenizer.
