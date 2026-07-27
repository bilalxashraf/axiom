import { deepEqual, ok, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  CanonicalJsonError,
  parseJson,
} from "../src/canonical.ts";

type RejectedCanonicalVector = {
  readonly name: string;
  readonly input_json: string;
  readonly error: "CanonicalJsonError";
};

type ConformanceVectors = {
  readonly format: "AXIOM-CONFORMANCE/0.1";
  readonly frozen: true;
  readonly canonical_json: {
    readonly rejected: readonly RejectedCanonicalVector[];
  };
};

test("the frozen cross-runtime conformance vectors match the implementation", async () => {
  const root = process.cwd();
  const expectedText = await readFile(
    join(root, "spec", "conformance-vectors.json"),
    "utf8",
  );
  const generatedText = execFileSync(
    process.execPath,
    [join(root, "scripts", "generate-conformance-vectors.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        TZ: "Pacific/Kiritimati",
        LANG: "C",
      },
    },
  );
  const expected = JSON.parse(expectedText) as ConformanceVectors;
  const generated = JSON.parse(generatedText) as unknown;
  deepEqual(generated, expected);
  ok(expected.format === "AXIOM-CONFORMANCE/0.1");
  ok(expected.frozen);

  for (const vector of expected.canonical_json.rejected) {
    throws(
      () => parseJson(vector.input_json),
      (error: unknown) => {
        ok(
          error instanceof CanonicalJsonError,
          `${vector.name} did not fail with CanonicalJsonError`,
        );
        return true;
      },
    );
  }
});
