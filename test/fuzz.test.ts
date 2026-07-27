import {
  deepEqual,
  equal,
  ok,
} from "node:assert/strict";
import { test } from "node:test";

import {
  CanonicalJsonError,
  canonicalJson,
  parseJson,
} from "../src/canonical.ts";
import { compileSource } from "../src/compiler.ts";
import {
  AxiomError,
} from "../src/errors.ts";
import {
  assertMarkdownMapMatchesSource,
  importMarkdown,
  validateMarkdownCoverageMap,
} from "../src/markdown.ts";
import { parse } from "../src/parser.ts";

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

test("seeded arbitrary-byte migration and parser corpus fails closed", () => {
  const cases = boundedEnvironmentInteger(
    "AXIOM_FUZZ_CASES",
    2_000,
    1_000_000,
  );
  let state = boundedEnvironmentInteger(
    "AXIOM_FUZZ_SEED",
    0x4158494f,
    0xffff_ffff,
  ) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let iteration = 0; iteration < cases; iteration += 1) {
    const length = next() % 129;
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = next() & 0xff;
    }
    const imported = importMarkdown(bytes, {
      sourcePath: "fuzz.md",
      axPath: "fuzz.ax",
      mapPath: "fuzz.axmap.json",
    });
    deepEqual(
      Buffer.from(imported.map.source.base64, "base64"),
      bytes,
      `migration changed bytes at seed state ${state} case ${iteration}`,
    );
    const map = validateMarkdownCoverageMap(imported.map);
    const ast = parse(imported.axSource, "fuzz.ax");
    const source = ast.declarations.find(
      (declaration) => declaration.kind === "SourceDecl",
    );
    ok(source !== undefined);
    assertMarkdownMapMatchesSource(map, source);

    const ascii = Array.from(bytes, (byte) =>
      String.fromCharCode(32 + (byte % 95)),
    ).join("");
    try {
      compileSource(ascii, `random-${iteration}.ax`);
    } catch (error) {
      ok(
        error instanceof AxiomError ||
          error instanceof CanonicalJsonError,
        `unexpected parser/compiler error at case ${iteration}: ${String(error)}`,
      );
    }
  }
});

test("seeded Unicode canonicalization corpus is total or explicitly rejected", () => {
  const cases = boundedEnvironmentInteger(
    "AXIOM_FUZZ_CASES",
    2_000,
    1_000_000,
  );
  let state = 0x554e4943;
  const next = (): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };

  for (let iteration = 0; iteration < cases; iteration += 1) {
    const length = next() % 33;
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(next() & 0xffff);
    }
    try {
      const encoded = canonicalJson({ value });
      const decoded = parseJson(encoded, { requireCanonical: true });
      equal(canonicalJson(decoded), encoded);
    } catch (error) {
      ok(
        error instanceof CanonicalJsonError,
        `unexpected canonicalization error at case ${iteration}: ${String(error)}`,
      );
    }
  }
});
