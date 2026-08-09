# Axiom Canonical JSON 0.1

## Status

This document is normative for Axiom Core 0.1 and 0.2, AIR/0.1 and AIR/0.2,
AXIP/1, AXLOG/0.1 and AXLOG/0.2, AXMAP/0.1, and AXLOCK/0.1 and AXLOCK/0.2.
“Must” and “must not” state conformance
requirements.

Axiom Canonical JSON is intentionally not RFC 8785 JCS. It uses a smaller
numeric domain and Unicode-scalar key ordering so its semantics do not inherit
one host language's UTF-16 representation.

## Value domain

A value is exactly one of:

- `null`;
- Boolean;
- a safe integer from `-9007199254740991` through `9007199254740991`;
- a string containing only Unicode scalar values;
- a finite dense ordered array of values; or
- a finite object whose keys are Unicode-scalar strings and whose values are
  values.

Fractional values, non-finite numbers, negative zero as a distinct value,
unpaired surrogate code units, sparse arrays, duplicate object names,
accessors, symbol keys, custom host prototypes, reference cycles, and nesting
deeper than 256 child edges are invalid.

A conforming parser must reject duplicate object names before constructing a
host object. It must not use first-name-wins or last-name-wins behavior.

## Strings

String equality is exact scalar-sequence equality. No NFC, NFD, case, locale,
or compatibility normalization occurs.

Serialization uses JSON quotation with these escapes:

- quotation mark as `\"`;
- reverse solidus as `\\`;
- U+0008, U+0009, U+000A, U+000C, and U+000D as `\b`, `\t`, `\n`, `\f`, and
  `\r`;
- other U+0000 through U+001F scalars as lowercase four-digit `\u00xx`; and
- all other scalar values directly as UTF-8.

Solidus is not escaped. A supplementary scalar is encoded directly as its
four-byte UTF-8 sequence, not as a pair of `\u` escapes.

## Numbers

Zero, including a host negative-zero input, serializes as `0`. Other integers
serialize as the shortest base-ten spelling with an optional leading minus and
no leading zero. Exponents and decimal points are forbidden.

## Arrays

Elements retain their declared order. They are separated by one comma with no
whitespace.

## Objects

Object keys are sorted lexicographically by Unicode scalar value. If one key is
a scalar-prefix of another, the shorter key sorts first. Members are separated
by one comma, names and values by one colon, and no whitespace is emitted.

Example:

```json
{"alpha":1,"":2,"😀":3}
```

U+E000 sorts before U+1F600 even though a UTF-16 code-unit comparison would
produce the opposite order.

## Hashes

Unless a containing specification defines another domain, a canonical hash is
lowercase SHA-256 over the exact UTF-8 serialization, written as
`sha256:` followed by 64 lowercase hexadecimal digits.

Semantic hashes use an explicit domain member in their hashed value. The Axiom
program semantic domain is `AXIOM-PROGRAM/0.1`; port and task lock signatures
use `AXIOM-PORT/0.1` and `AXIOM-TASK/0.1`.

## Required vectors

| Value | Canonical bytes |
| --- | --- |
| negative zero | `0` |

Decoders return the normalized in-memory value, so a parsed `-0` becomes
positive zero. Runtime inputs, bindings, effect arguments, and ledger payloads
are detached canonical snapshots rather than aliases to caller-owned objects.
| composed e-acute | `"é"` |
| decomposed e-acute | `"é"` |
| scalar-order object | `{"":1,"😀":2}` |
| maximum integer | `9007199254740991` |

The two e-acute strings above are distinct. Lone `\ud800`, `1.5`, `1e3`,
`9007199254740992`, duplicate names, and a 257-edge nesting chain must fail.
