# Model independence

Axiom is model-independent at the language boundary: the program's meaning is
defined without reference to a model vendor, tokenizer, SDK, sampling API,
chat-message format, or native tool-calling feature.

That does not mean every model has equal reasoning ability. It means any model
is replaceable without giving it control over obligations or execution.

## The portability contract

A model adapter has one job:

```text
normalized inference frame -> normalized inference outcome
```

The frame contains:

- a protocol version;
- stable program, run, and operation identities;
- the inference port's intent;
- typed input;
- an output schema;
- active obligation identifiers;
- allowed response kinds;
- context and prologue references; and
- input-byte, output-byte, and attempt budgets.

The outcome is exactly one of:

- `candidate`: a value for schema checking and later validation;
- `need_context`: a request for listed content-addressed references; or
- `fail`: a structured refusal or inability to produce a candidate.

Provider-specific finish reasons, safety responses, usage fields, and error
objects are normalized by the adapter. They do not leak into language
semantics.

AXIP/1 defines all three outcomes. The certified Core 0.1 VM currently permits
`candidate` and `fail`; its context-reference list is empty, so
`need_context` fails explicitly instead of causing an undeclared retrieval.

## Minimum adapter profile

A provider does not need native JSON schema, tool calling, a system role, prompt
caching, or a known tokenizer. The minimum profile is:

1. accept a finite UTF-8 request;
2. return a finite UTF-8 response or a structured transport failure; and
3. allow the adapter to identify the selected model in the ledger.

For a plain text-completion model, the adapter serializes the normalized frame,
asks for one protocol response, parses the returned JSON, and reports failure
if parsing or schema validation does not succeed within the declared attempts.

Native structured output may improve reliability, but it is an adapter
optimization. Native tool calling is intentionally unnecessary: Axiom models
do not call tools. They propose a typed candidate; the runtime decides what
operation can occur next.

## Core 0.1 adapter kit

The implementation keeps one small `AgentModelAdapter.complete` interface and
ships several ways to satisfy it:

| Adapter | Use |
| --- | --- |
| `TextFunctionAdapter` | Wrap an SDK call or local inference function |
| `HttpTextAdapter` | POST AXIP text directly or through JSON encode/decode hooks |
| `FixtureAdapter` | Deterministic offline tests |
| `ReplayAdapter` | Reuse responses matched by semantic request hash |

Provider-native message roles, authentication, endpoints, and response
envelopes stay inside the adapter. They do not appear in AIR or task source.
`HttpTextAdapter` measures the endpoint, merged headers, and encoded request
body before `fetch`, reads response streams through a finite byte cap, and
permits a separately bounded provider envelope without relaxing the decoded
AXO budget. Request bodies whose size cannot be established—such as streams and
`FormData`—fail closed. Its public deadline covers encoding, transport,
bounded reading, and decoding, including hooks that ignore cancellation.

## Optional optimization profiles

Core 0.1 already supports the narrow cache-safe mechanism it needs:
`cachedPrologueRefs` advertises exact installed prologue hashes. A future,
richer adapter profile can advertise other optional capabilities:

```text
structured_output
deterministic_seed
usage_tokens
streaming
context_fetch
```

The Core 0.1 adapter interface deliberately requires none of them. Programs do
not branch on vendor identity. A runtime may use an optional capability only
when doing so preserves the same normalized frame and outcome semantics. For
example:

- With `structured_output`, the adapter supplies the output schema through the
  provider's native feature.
- Without it, the adapter embeds the same schema in the cacheable prologue and
  validates the text response itself.
- With an exact entry in `cachedPrologueRefs`, the runtime sends the referenced
  prologue; without it, the runtime sends the inline prologue.

Unsupported optimizations may cost more or fail more often; they cannot relax
the program.

## Why byte budgets, not token budgets

There is no portable token. The same text can have different token counts
across providers, model versions, and even tokenizer revisions.

Axiom therefore makes UTF-8 bytes normative:

```axiom
infer raw_plan = planner(input)
  limit input_bytes 16384 output_bytes 4096 attempts 2;
```

The runtime can calculate and enforce these limits before and after every call,
regardless of provider. The HTTP endpoint, merged headers, and body—including a
JSON wrapper—count toward `input_bytes`; unknown-size request bodies fail
closed. HTTP responses are read incrementally through a finite transport cap,
and the decoded AXO text is checked against `output_bytes`. An adapter may also
set a conservative provider token limit and report actual token usage when
available, but token counts are telemetry rather than portable semantics.

An input that exceeds `input_bytes` is not silently truncated. Core 0.1 fails
the inference. A future context-enabled profile may replace selected content
with declared references before encoding, but it may not expand the source
budget implicitly.

Byte limits bound space, not time. Every live inference attempt has a
30-second runtime deadline by default. Hosts can set
`RunOptions.inferenceTimeoutMs`, and the CLI exposes
`--inference-timeout-ms`. The outer AXIP invocation remains bounded even if an
adapter ignores cancellation.

## Token-efficient execution

### Node-local frames

The model does not receive the task source or the entire execution history.
Core 0.1 evaluates the declared arguments of the current `infer` port and sends
only those values as dynamic input. The frame includes:

- the current intent;
- the live input value;
- the expected output shape;
- unresolved obligation identifiers relevant to the site; and
- explicit context references.

Tool receipts not passed as arguments, old candidate text, source comments, and
other task bodies stay out of the prompt. Core 0.1 includes only record-schema
definitions reachable from the inference input and output types, so unrelated
records consume no model tokens.

### Content addressing

Context chunks and the protocol prologue are serialized canonically and named
by SHA-256. A frame can carry:

```json
{
  "prologueRef": "sha256:...",
  "contextRefs": ["sha256:..."]
}
```

The adapter expands a reference only when the provider has not cached it. The
hash names the exact content the host expects. It enables a trusted cache to
detect wrong content, but does not attest that a remote provider actually
installed or honored that content; cache configuration remains part of the
trusted adapter boundary.
Input and output schemas use a compact inline encoding in AXIP/1. A future
protocol version may add schema references without changing Axiom semantics.

### Cached prologue

The stable prologue explains the protocol and response envelope once. Its
content changes only when the protocol version or adapter profile changes.
Providers with prompt caching can reuse it; local models can retain its KV
cache; basic providers receive the same bytes each time.

Core 0.1 implements the selection path: model adapters may advertise
`cachedPrologueRefs`, and the VM uses `AXP1 @<hash>` only when the exact current
`AXIP_PROLOGUE_HASH` is present. Otherwise it sends the inline bytes. The
CLI's `--cached-prologue` flag makes that advertisement for its HTTP adapter;
it asserts that the remote cache is already installed and does not install it.
AXIP/1 rejects any other prologue digest, so a generic caller cannot create a
second semantic prologue under the same protocol version.

The prologue contains protocol mechanics, not task-specific instructions. The
task intent remains visible in the dynamic node frame so caching cannot bind
one task's authority to another.

### Compact wire form

The public API uses descriptive field names for readability. The adapter wire
format may map those fields to versioned short keys and canonical JSON. Compact
encoding is mechanically reversible and never interpreted by the model as
language source. AXIP JSON rejects duplicate object keys so portability does
not depend on first-key or last-key parser behavior.

Binary encodings such as canonical CBOR are possible in later protocol
profiles. JSON is the Core 0.1 interoperability baseline because virtually
every provider can emit it.

### Measured efficiency

For each inference, the ledger should record:

- dynamic input and output bytes;
- expanded and referenced context bytes;
- cache-hit status;
- attempts;
- provider-reported input and output tokens, when available; and
- the hashes of the prologue, schema, and context.

This makes “token efficient” measurable. A conformance benchmark can compare a
full Markdown prompt with the Axiom node frame for the same task without
depending on a single tokenizer.

## What remains constant across models

Changing the adapter or model does not change:

- parsed source and canonical AIR;
- operation order and legal transitions;
- task obligations;
- tool read/write modes;
- validator and verifier authority;
- idempotency keys;
- byte and attempt limits;
- completion criteria; or
- ledger and replay rules.

The model can change only the candidate value (or fail to provide one).
Loaded or externally supplied AIR is not trusted merely because it has a
canonical hash: the strict AIR verifier rechecks shapes, types, ports,
operation sites, immutable bindings, terminals, and obligation/evidence flow
before execution.

## Reproducibility

A temperature of zero or a provider seed is not a correctness mechanism. Model
implementations, kernels, routing, and provider behavior can change.

Axiom distinguishes:

1. **semantic portability**: every adapter sees the same normalized inference;
2. **control determinism**: the runtime handles a given outcome identically;
3. **live reproducibility**: best effort and provider-dependent; and
4. **replay determinism**: exact, because recorded outcomes replace live calls.

The ledger records adapter ID, provider model ID when supplied, normalized
request hash, normalized response, and optional provider metadata. Its run
header also records `trusted_bindings`: the host binding-set ID, optional
lowercase SHA-256 implementation fingerprint, and model-adapter ID. The
fingerprint is supplied by the trusted host and should identify the exact tool,
validator, and verifier implementation package. A replay requires no access to
the original model and preserves the recorded binding provenance.

## Trust and quality

Provider neutrality cannot guarantee output quality. A tiny model may fail the
schema, propose a poor plan, or exhaust its attempts. The task then fails or
blocks visibly.

Safety comes from confining that uncertainty:

```text
model output
  -> Candidate<T>
  -> schema check
  -> declared validator
  -> T
  -> capability-checked effect
  -> receipt
  -> verifier
  -> Evidence<P>
```

No adapter may directly produce `Evidence<P>`, mark an obligation satisfied,
execute a tool, or return task completion.

## Conformance testing

Core 0.1 exports `checkAdapterConformance(adapter, options)`. The bounded probe
sends one typed nonce-preservation request and checks strict AXIP framing,
identity echoing, schemas, budgets, and exact value preservation. It reports
the adapter/model IDs, semantic request hash, frame and response byte counts,
and inline-versus-referenced prologue mode. Its default timeout is 30 seconds.

This is a minimum compatibility probe, not a quality benchmark. A broader
conformance corpus should still compare fixture, replay, plain-text, native
structured-output, and local-model adapters. Direct AXIP HTTP endpoints can run
the same probe with `axiom conform --adapter-url <url>`. Quality benchmarks
remain separate from protocol conformance.

## Honest claim

The accurate promise is:

> Any model that can exchange bounded UTF-8 data can be connected through an
> adapter, while Axiom retains control of obligations, effects, validation, and
> completion.

It is not:

> Every model will understand every intent, produce the same output, or
> successfully solve every Axiom task.
