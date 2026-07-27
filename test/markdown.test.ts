import {
  deepEqual,
  equal,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import { sha256Bytes } from "../src/canonical.ts";
import {
  compileSource,
  reviewDispositionsHash,
} from "../src/compiler.ts";
import { CheckError } from "../src/errors.ts";
import { importMarkdown } from "../src/markdown.ts";
import { parse } from "../src/parser.ts";

test("Markdown import is byte-lossless and every nonblank span is unresolved", () => {
  const bytes = Buffer.from(
    "# Rules\r\n\r\nYou must inspect café.\n- Never skip tests\n```sh\nnpm test\n```\n",
    "utf8",
  );
  const imported = importMarkdown(bytes, {
    sourcePath: "AGENTS.md",
    axPath: "AGENTS.ax",
    mapPath: "AGENTS.axmap.json",
  });

  equal(
    Buffer.from(imported.map.source.base64, "base64").compare(bytes),
    0,
  );
  equal(imported.map.source.byte_length, bytes.byteLength);
  equal(imported.map.source.sha256, sha256Bytes(bytes));
  equal(imported.map.coverage.complete_partition, true);

  let cursor = 0;
  for (const span of imported.map.coverage.spans) {
    equal(span.byte_start, cursor);
    ok(span.byte_end > span.byte_start);
    equal(
      span.sha256,
      sha256Bytes(bytes.subarray(span.byte_start, span.byte_end)),
    );
    cursor = span.byte_end;
    if (span.category === "blank") {
      equal(span.disposition.status, "retained_whitespace");
    } else {
      equal(span.disposition.status, "unresolved");
    }
  }
  equal(cursor, bytes.byteLength);

  deepEqual(
    imported.map.coverage.spans.map((span) => span.category),
    ["heading", "blank", "prose", "list", "code", "code", "code"],
  );

  const ast = parse(imported.axSource, "AGENTS.ax");
  equal(ast.declarations[0]?.kind, "SourceDecl");
  equal(
    ast.declarations.filter(
      (declaration) => declaration.kind === "UnresolvedDecl",
    ).length,
    6,
  );
  throws(
    () => compileSource(imported.axSource, "AGENTS.ax"),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1000");
      match(error.message, /Unresolved imported clause `md_000001`/u);
      return true;
    },
  );
});

test("blank Markdown remains lossless without inventing an obligation", () => {
  const bytes = Buffer.from("\r\n \t\n", "utf8");
  const imported = importMarkdown(bytes, {
    sourcePath: "empty.md",
    axPath: "empty.ax",
    mapPath: "empty.axmap.json",
  });

  ok(
    imported.map.coverage.spans.every(
      (span) => span.disposition.status === "retained_whitespace",
    ),
  );
  equal(
    imported.axSource.includes("unresolved "),
    false,
  );
  equal(compileSource(imported.axSource).program.tasks.length, 0);

  const falseSeal =
    `${imported.axSource}review markdown_source ` +
    `source_hash "sha256:${"0".repeat(64)}" ` +
    `dispositions_hash "sha256:${"f".repeat(64)}";\n`;
  throws(
    () => compileSource(falseSeal),
    (error: unknown) =>
      error instanceof CheckError && error.code === "AX1043",
  );

  const validSeal =
    `${imported.axSource}review markdown_source ` +
    `source_hash "${imported.map.source.sha256}" ` +
    `dispositions_hash "${reviewDispositionsHash(
      "markdown_source",
      [],
      () => undefined,
    )}";\n`;
  equal(compileSource(validSeal).program.tasks.length, 0);
});

test("malformed UTF-8 is retained exactly and fails closed as unresolved", () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x0a]);
  const imported = importMarkdown(bytes, {
    sourcePath: "damaged.md",
    axPath: "damaged.ax",
    mapPath: "damaged.axmap.json",
  });

  deepEqual(
    [...Buffer.from(imported.map.source.base64, "base64")],
    [...bytes],
  );
  equal(imported.map.coverage.spans[0]?.category, "prose");
  equal(
    imported.map.coverage.spans[0]?.disposition.status,
    "unresolved",
  );
  throws(
    () => compileSource(imported.axSource),
    (error: unknown) => error instanceof CheckError && error.code === "AX1000",
  );
});

test("embedded coverage prevents deleting or altering unresolved spans", () => {
  const imported = importMarkdown(Buffer.from("# Rule\nDo it.\n", "utf8"), {
    sourcePath: "rules.md",
    axPath: "rules.ax",
    mapPath: "rules.axmap.json",
  });

  const deleted = imported.axSource
    .split("\n")
    .filter((line) => !line.startsWith("unresolved md_000002 "))
    .join("\n");
  throws(
    () => compileSource(deleted),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1030");
      match(error.message, /requires 2 unresolved spans, found 1/u);
      return true;
    },
  );

  const altered = imported.axSource.replace(
    'category "heading"',
    'category "prose"',
  );
  throws(
    () => compileSource(altered),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1032");
      return true;
    },
  );

  const sourceTamper = imported.axSource.replace(
    /base64 "[A-Za-z0-9+/=]+"/u,
    'base64 "QQ=="',
  );
  throws(
    () => compileSource(sourceTamper),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1027");
      return true;
    },
  );
});

test("source provenance and unresolved ranges are checked before rejection", () => {
  const embedded = Buffer.from("abcd", "utf8");
  const invalid = `
axiom 0.1;
source markdown_source path "rules.md"
  hash "${sha256Bytes(embedded)}"
  bytes 4 base64 "${embedded.toString("base64")}" map "rules.axmap.json";
unresolved md_000001 source markdown_source bytes 0 5
  hash "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  category "prose" reason "Needs semantics.";
`;

  throws(
    () => compileSource(invalid, "invalid-import.ax"),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, "AX1023");
      return true;
    },
  );
});
