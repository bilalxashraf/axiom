# Lossless Markdown import

`import-md` creates a migration draft. It does not claim to understand natural
language:

```sh
axiom import-md AGENTS.md -o AGENTS.ax
```

This writes:

- `AGENTS.ax`, containing the exact source bytes in a content-addressed
  `source` declaration and one explicit `unresolved` declaration for every
  nonblank source span; and
- `AGENTS.axmap.json`, an `AXMAP/0.1` coverage sidecar.

Use `--map path` to choose a different sidecar path. When combining multiple
Markdown imports in one program, give each a unique source namespace with
`--source-id name`; its generated IDs become, for example,
`name_md_000001` and `name_span_000001`.

## Losslessness and coverage

The sidecar stores the original file as base64, its exact byte length, and its
SHA-256 hash. Its spans form a checked, non-overlapping half-open partition of
the bytes:

```text
[0, first_end) [first_end, second_end) ... [last_end, byte_length)
```

Each span also has a category, its own SHA-256 hash, and a disposition. Blank
spans are `retained_whitespace`. Every other span—heading, prose, list, or
code—is `unresolved` and names the matching declaration in the generated
`.ax` file. Fenced code remains code through its closing fence. Classification
decodes UTF-8 with replacement for malformed sequences, so even a damaged or
non-UTF-8 `.md` file remains importable; line endings and every original byte
are preserved verbatim in the base64 payload.

The complete source payload is intentional. A coverage map can reconstruct and
hash-check the input without trusting path contents or a later filesystem
snapshot. The `.ax` file embeds the same payload, allowing the strict compiler
to derive and check coverage independently. The CLI additionally requires the
sidecar named by every `source` declaration on all `.ax` load paths, validates
every derived field, and cryptographically matches it to the declaration. This
external anchor detects wholesale deletion of the source declaration and its
dispositions. `--map path` can add an explicit anchor, but does not replace a
different path named by the declaration.

## Why import is conservative

No general algorithm can reliably tell whether arbitrary Markdown is an
instruction, example, fact, preference, or documentation. Guessing would
reintroduce the omission problem Axiom is meant to prevent. The importer
therefore treats every nonblank span as potentially normative:

```axiom
source markdown_source path "AGENTS.md"
  hash "sha256:..." bytes 123 base64 "IyBSdWxlcy4uLg=="
  map "AGENTS.axmap.json";

unresolved md_000001 source markdown_source bytes 0 17
  hash "sha256:..." category "heading"
  reason "Imported Markdown heading may carry instructions, constraints, examples, or context; executable semantics were not inferred automatically.";
```

The parser accepts this draft so tools can inspect it. Before reporting the
expected `AX1000`, the strict compiler decodes the embedded bytes, verifies
their length and hash, derives the expected coverage again, and matches every
unresolved declaration by ID, source, byte range, span hash, and category.
Deleting or modifying one produces a coverage error instead of making the
program compile. Merely deleting the declarations is not resolution.

## Explicit review and resolution

For every nonblank span, a reviewer must inspect the original bytes and choose
one of two dispositions:

```axiom
resolved ID source SRC bytes START END hash "sha256:SPAN_HASH" as requirement
  task TASK obligation OBL reason "Why this obligation represents the span.";

resolved ID source SRC bytes START END hash "sha256:SPAN_HASH" as non_normative
  reason "Why this span does not constrain execution.";
```

`ID` is the compiler-derived coverage span ID, such as `span_000001`, from the
sidecar—not the generated unresolved declaration name such as `md_000001`.
`SRC` is the `source` declaration name. `START`, `END`, and `SPAN_HASH` are the
half-open byte range and SHA-256 value copied from that span's coverage-map
entry. They bind the review decision to the exact source content.

For example:

```axiom
resolved span_000001 source markdown_source bytes 0 17
  hash "sha256:0123..." as non_normative
  reason "This heading only labels the section.";

resolved span_000002 source markdown_source bytes 17 61
  hash "sha256:4567..." as requirement
  task Fix obligation inspected
  reason "A reviewer linked the instruction to Fix.inspected.";

review markdown_source
  source_hash "sha256:SOURCE_HASH"
  dispositions_hash "sha256:CANONICAL_DISPOSITIONS_HASH";
```

Remove the matching `unresolved` declaration when adding its `resolved`
declaration. The compiler requires exactly one disposition for every nonblank
span. It rejects missing or dual dispositions, unknown span/source IDs, empty
reasons, stale byte-range/hash bindings, and requirement links that do not name
an existing task obligation. If imported text changes or moves, the compiler
reports `AX1041` until the affected disposition is reviewed and rebound.

Once every span has a disposition, strict compilation also requires exactly one
source-wide seal:

```axiom
review SRC
  source_hash "sha256:SOURCE_HASH"
  dispositions_hash "sha256:CANONICAL_DISPOSITIONS_HASH";
```

`SOURCE_HASH` must equal the imported `source` declaration. The dispositions
digest is `AXREVIEW-DISPOSITIONS/0.2`: canonical JSON over the source ID and all
that source's resolution IDs, ranges, span hashes, disposition kinds,
task/obligation links, linked proposition names and modes, reasons, and the
`AXREVIEW-FORMAL/0.1` hash of every executable record, proposition, port,
validator, verifier, and task declaration, sorted by ID. If the seal is absent
or stale, the compiler diagnostic prints the exact expected declaration or
hash after all lower-level coverage checks pass.

This O(1)-per-source seal matters because a line can stay byte-identical while
surrounding text changes its meaning—for example, an instruction moving from
an “enforced” section to an “example” section. Any source-byte change
invalidates `source_hash`; any disposition change invalidates
`dispositions_hash`. Changing formal behavior while preserving task,
obligation, proposition, or port names also invalidates the digest. Updating
the seal is an explicit source-wide re-attestation. A fully reviewed and sealed source may
compile; all migration declarations are provenance and do not enter executable
AIR or model prompts. A whitespace-only source needs no seal; if an author
supplies one, both its source hash and canonical empty disposition hash are
still validated.

The resolution is deliberately an explicit review record, not an automatic NLP
translation. A model may propose it, but a human or trusted process must decide
whether the mapping is acceptable. The compiler can prove byte retention,
complete disposition coverage, a valid obligation link, and seal freshness. It
cannot prove that the obligation captures every nuance of the prose, that a
`non_normative` judgment is true, or that whoever updated the seal actually
performed a competent review. Protect seal changes with ordinary code review,
CI ownership, or signatures when that assurance is required.

`AXMAP/0.1` is an import receipt, not a proof that the intended meaning was
captured. It proves byte retention and explicit disposition coverage only.
