# AXIP/1: Axiom inference protocol

AXIP/1 is the provider-neutral boundary between the Axiom runtime and a model
adapter. It turns an `infer` operation into a small typed request and accepts
one strictly framed outcome.

The model is not sent an Axiom program to execute. The runtime has already
selected the inference node, evaluated its arguments, and determined the active
obligations and legal responses.

## 1. Readable request API

The runtime-facing request has this shape:

```ts
interface AxipRequest {
  protocol: "AXIP/1";
  runId: string;
  programHash: `sha256:${string}`;
  nodeId: string;
  operation: string;
  inputSchema: CompactSchema;
  outputSchema: CompactSchema;
  schemaDefinitions?: Record<string, CompactSchema>;
  inputs: JsonValue;
  activeObligations: string[];
  allowedResponses: ("candidate" | "need_context" | "fail")[];
  budget: {
    maxInputBytes: number;
    maxOutputBytes: number;
    maxTokens: number;
    maxAttempts: number;
  };
  contextRefs: string[];
  prologueRef?: string;
}
```

All budgets are positive safe integers. Identifiers and references are nonempty
and duplicate-free where they form sets. `programHash` is a lowercase SHA-256
digest. In AXIP/1, an optional `prologueRef` must equal the exported
`AXIP_PROLOGUE_HASH` for the one fixed inline semantic prologue. `inputs` must
match `inputSchema` before a frame can be encoded.

`maxInputBytes`, `maxOutputBytes`, and `maxAttempts` come from the Axiom
inference site or a stricter host policy. `maxTokens` is an adapter-facing cap
for providers that expose tokens; byte limits remain normative and portable.
Core 0.1 populates `maxTokens` from `input_bytes` because the source language
does not yet expose a provider-specific token limit; an adapter may apply a
stricter token cap.

These wire budgets do not replace a liveness deadline. The runtime gives each
live inference attempt 30 seconds by default and passes that deadline through
the adapter boundary. Hosts can set `RunOptions.inferenceTimeoutMs`; the CLI
exposes `--inference-timeout-ms`. The outer invocation deadline still fails
boundedly if a provider transport ignores cancellation.

## 2. Text transport

AXIP/1 has three magic lines:

- `AXP1`: semantic prologue;
- `AXF1`: inference frame; and
- `AXO1`: model output.

With an inline prologue, a request is:

```text
AXP1
Act as a typed inference function. Read the AXF1 JSON frame.
Keys: r=run, p=program, n=node, o=operation, i=input schema, u=output schema, x=inputs, g=active obligations, a=allowed outputs(c/n/f), b=limits[input bytes/output bytes/tokens/attempts], c=context refs, d=definitions, h=prologue ref.
Schema: "*"=any, "0"=null, "b"=boolean, "s"=string, "n"=number, "i"=integer. Tagged arrays: ["s",min?,max?,pattern?], ["n"|"i",min?,max?], ["=",literal], ["e",...values], ["a",item,min?,max?], ["t",items,rest?], ["o",[[name,schema,optional-0?]],additional?], ["u",...variants], ["r",name]. null placeholders mean omitted.
Reply with only AXO1 then JSON. Echo r and n. k="c": include v matching u; k="n": include q, refs from c; k="f": include e={c:code,m:message,r:retryable,d?:details}.
Use only a response kind listed in a. Do not add keys, prose, or markdown.
AXF1
<canonical compact JSON>
```

When an adapter has already installed the exact prologue, the preamble may be
replaced with:

```text
AXP1 @<AXIP_PROLOGUE_HASH>
AXF1
<canonical compact JSON>
```

The same fixed reference must appear in the payload's `h` field. AXIP/1 rejects
other hash-shaped references. A referenced prologue is a cache optimization,
not permission to select or substitute a different one.

The encoded request, including prologue and framing, must fit
`maxInputBytes`. The output, including `AXO1`, must fit `maxOutputBytes`.
Lengths are measured after UTF-8 encoding.

AXF1 and AXO1 JSON reject duplicate object keys. A payload such as
`{"k":"c","k":"f",...}` is invalid rather than depending on a parser's
first-key or last-key behavior.

AXIP uses Axiom canonical JSON, not an unspecified provider JSON dialect:
strings contain Unicode scalar values only; object keys are ordered
lexicographically by scalar value; no normalization is performed; numbers are
safe integers only; and nesting is bounded. `Bytes` values are canonical padded
RFC 4648 base64. The certified schema profile permits no arbitrary host regex;
its sole pattern is the fixed canonical-base64 language. These constraints are
conformance requirements for non-TypeScript adapters.

## 3. Compact request payload

The public request is encoded with versioned short keys:

| Key | Meaning |
| --- | --- |
| `r` | run ID |
| `p` | canonical AIR program hash |
| `n` | inference node ID |
| `o` | inference operation intent |
| `i` | compact input schema |
| `u` | compact output schema |
| `x` | evaluated input value |
| `g` | active obligation IDs |
| `a` | allowed response codes |
| `b` | four budgets |
| `c` | available context references |
| `d` | optional named schema definitions |
| `h` | optional installed-prologue reference |

`b` is ordered:

```text
[maxInputBytes, maxOutputBytes, maxTokens, maxAttempts]
```

Response codes are:

```text
c = candidate
n = need_context
f = fail
```

The compact schema vocabulary uses one-character scalar tags and tagged
arrays. Common forms are:

| Encoding | Schema |
| --- | --- |
| `"*"` | any JSON value |
| `"0"` | null |
| `"b"` | boolean |
| `"s"` | unconstrained string |
| `"i"` | integer |
| `"n"` | safe integer (a compatibility spelling distinct from `"i"` metadata) |
| `["a", S]` | array of schema `S` |
| `["o", [["field", S], ...]]` | closed required-field record |
| `["u", S1, S2, ...]` | union |
| `["r", "Name"]` | named definition reference |

The implementation also supports literal, enum, tuple, optional record-field,
length, range, pattern, and additional-field encodings. Schemas are validated
before use, and references resolve only through the frame's definitions.

## 4. Example request

The following compact payload represents the `planner` inference in
`examples/fix.ax`. The all-zero digest is illustrative.

```json
{
  "a": ["c", "f"],
  "b": [16384, 4096, 16384, 2],
  "c": [],
  "d": {
    "Facts": ["o", [["files", ["a", "s"]]]],
    "Issue": ["o", [["summary", "s"], ["terms", ["a", "s"]]]],
    "Plan": ["o", [["file", "s"], ["patch", "s"]]],
    "PlannerInput": [
      "o",
      [
        ["issue", ["r", "Issue"]],
        ["facts", ["r", "Facts"]]
      ]
    ]
  },
  "g": ["applied", "tests"],
  "i": ["o", [["input", ["r", "PlannerInput"]]]],
  "n": "Fix:3:planner",
  "o": "Choose one relevant file and propose the smallest patch.",
  "p": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "r": "run-001",
  "u": ["r", "Plan"],
  "x": {
    "input": {
      "facts": {"files": ["src/greeter.ts"]},
      "issue": {
        "summary": "The greeting still says hello after the product was renamed.",
        "terms": ["hello", "greeting", "product name"]
      }
    }
  }
}
```

Actual wire JSON is canonical and therefore contains no indentation and has
lexicographically sorted object keys.

## 5. Output frames

An output is exactly:

```text
AXO1
<one JSON object>
```

One final LF is permitted. Prefix prose, Markdown fences, suffix text, unknown
keys, and multiple objects are rejected. Model responses are not
“helpfully” repaired.

### Candidate

```text
AXO1
{"k":"c","n":"Fix:3:planner","r":"run-001","v":{"file":"src/greeter.ts","patch":"replace greeting"}}
```

The runtime checks that:

- `r` and `n` exactly echo the request;
- `candidate` was allowed at this node; and
- `v` matches the declared output schema.

The accepted value is still `Candidate<Plan>`. Protocol schema validation does
not replace the Axiom `validate` operation.

### Need context

```text
AXO1
{"k":"n","n":"task:site:model","q":["sha256:context-chunk"],"r":"run-001"}
```

Every requested reference must have been offered in the request's `c` list,
and `q` must be nonempty and duplicate-free. Resolving a reference and issuing
a subsequent frame is an adapter/runtime concern; AXIP/1 never allows the model
to request an arbitrary file or URL.

AXIP/1 defines this outcome for adapters and future runtimes. The certified
Core 0.1 VM currently offers no context references and permits only `candidate`
and `fail`, so a live `need_context` outcome fails visibly.

### Failure

```text
AXO1
{"e":{"c":"NO_PLAN","m":"No relevant file was found.","r":false},"k":"f","n":"Fix:3:planner","r":"run-001"}
```

The failure object contains:

- `c`: stable error code;
- `m`: human-readable message;
- `r`: whether another attempt could succeed; and
- optional `d`: JSON details.

A failure is not task completion and does not satisfy any obligation.

## 6. Attempts and validation

For each attempt, the adapter:

1. verifies and encodes the normalized request;
2. enforces the input byte budget on the normalized frame;
3. if it adds a provider envelope, enforces the same budget on all
   application-controlled HTTP request material;
4. invokes the selected provider;
5. reads the provider response through a finite transport bound;
6. enforces the decoded AXO output byte budget before parsing;
7. requires exact `AXO1` framing and JSON shape;
8. verifies run ID, node ID, response kind, and output schema; and
9. returns a normalized outcome or structured protocol error.

Retry policy is bounded by `maxAttempts`. An adapter may retry a transport
failure or a retryable model failure according to host policy. It must not
silently expand budgets, modify inputs, weaken schemas, change obligations, or
turn invalid output into a candidate.

### HTTP transport bounds

`HttpTextAdapter` checks the endpoint text, merged header names and values, and
encoded HTTP request body before calling `fetch`. This conservative,
deterministic accounting prevents prompts placed in a query or custom header
from escaping the input budget. Strings—including JSON wrappers—are counted as
UTF-8; `URLSearchParams`, `Blob`, `ArrayBuffer`, and typed-array views also have
measurable sizes. Request material larger than `maxInputBytes` fails with
`AXIP_HTTP_REQUEST_BUDGET`. Streaming and multipart `FormData` bodies have no
portable finite size at this boundary and fail closed with
`AXIP_HTTP_REQUEST_BODY_UNBOUNDED`. They are not buffered without limit to
discover a size.

The response body is read incrementally and cancelled when its transport limit
is exceeded. The default transport limit is `maxOutputBytes`. A provider JSON
envelope may use an explicitly configured finite
`maxTransportResponseBytes`, but the decoded AXO text must still fit
`maxOutputBytes`. Thus envelope overhead can be accommodated without relaxing
the language-level output budget. HTTP error diagnostics are bounded as well.

## 7. Context and cache behavior

`contextRefs` are opaque handles selected by the runtime. Deployments should
make them content-addressed and immutable. They keep large context out of the
initial frame and constrain what a model may ask to reveal. A content-addressed
store verifies bytes against the reference before expansion.

The semantic prologue is stable across tasks and identified by an exact
lowercase `sha256:<64 hex digits>` reference. This single-line grammar prevents
control text from being injected into the `AXP1 @<hash>` preamble.
An adapter advertises already installed hashes through
`cachedPrologueRefs`. The runtime sends `AXP1 @<hash>` only when that exact
list contains `AXIP_PROLOGUE_HASH`; otherwise it sends the inline prologue.
`HttpTextAdapter` supports this advertisement, and the CLI's
`--cached-prologue` flag declares that the configured HTTP endpoint has the
exact current prologue installed. The flag does not install or verify a remote
cache by itself. Both transport modes decode to the same normalized request.

The request payload hash is computed independently of inline-versus-referenced
prologue transport. It is the stable lookup key for fixtures and replay.

## 8. Provider adapter requirements

A conforming adapter must:

- preserve the normalized request semantics;
- record its adapter ID and, when available, concrete model ID;
- enforce provider limits no less strictly than Axiom limits;
- normalize provider failures instead of exposing vendor control flow;
- never execute tools on behalf of the model;
- never manufacture validator output or verifier evidence; and
- return usage metrics when available without making token counts normative.

The invocation object and its recursively nested semantic request are immutable
snapshots decoded from the exact emitted frame. Response budgets and schemas
are checked against that snapshot, so adapter code cannot mutate a request
after hashing to weaken validation. `HttpTextAdapter.complete()` applies its
deadline to request encoding, transport, bounded reading, and response
decoding—even if a hook or transport ignores cancellation.

Native structured output may carry `outputSchema` out of band. Native prompt
caching may carry the prologue by reference. Neither feature changes the AXIP
outcome.

## 9. Adapter conformance probe

The package exports:

```ts
checkAdapterConformance(adapter, {
  nonce?: string,
  timeoutMs?: number,
})
```

This finite, provider-neutral probe sends one typed nonce-preservation
inference and verifies AXIP framing, identity echoing, schema validation,
budgets, and the exact returned value. It reports adapter/model identity,
semantic request hash, frame and response bytes, and whether the prologue was
inline or referenced. The default probe timeout is 30 seconds.

The probe establishes minimum transport compatibility, not reasoning quality,
safety, or suitability for a task. It is also available for direct AXIP HTTP
endpoints:

```sh
axiom conform --adapter-url http://127.0.0.1:8080 \
  --timeout-ms 30000
```

## 10. Ledger and replay

The ledger records the normalized effect request and response, hashes them
canonically, and chains each entry to the previous hash. At replay, the runtime
requires the next recorded request to match the current request before
supplying its response.

The run header also records `trusted_bindings`: the host binding-set ID,
optional lowercase SHA-256 implementation fingerprint, and model-adapter ID.
This makes the trusted tool/validator/verifier implementation set visible in
the audit trail. The fingerprint is host-supplied provenance, not remote
attestation; production hosts should bind it to the exact implementation
package they trust.

This gives exact replay even when the original model is unavailable. AXIP
framing and hashes detect mismatch; they are not encryption or remote
authentication. A deployment still needs an authenticated transport and a
trusted host boundary.

## 11. Token-efficiency invariant

A conforming runtime must not send the whole `.ax` source by default. It builds
each frame from values live at that `infer` node and references reusable
content. All application-controlled HTTP request material—not only the
body—counts toward `maxInputBytes`.

This keeps optimization subordinate to semantics:

```text
same normalized frame + same normalized outcome
=> same Axiom execution transition
```

Provider-specific compression, caching, or tokenization may change cost, but
not what the model is authorized to return.
