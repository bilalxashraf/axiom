import { deepEqual, equal, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("the frozen Core 0.2 control-flow vectors match the implementation", async () => {
  const root = process.cwd();
  const expectedText = await readFile(
    join(root, "spec", "control-flow-vectors.json"),
    "utf8",
  );
  const generatedText = execFileSync(
    process.execPath,
    [join(root, "scripts", "generate-control-flow-vectors.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TZ: "Pacific/Kiritimati", LANG: "C" },
    },
  );
  const expected = JSON.parse(expectedText) as {
    readonly format: string;
    readonly frozen: boolean;
    readonly executions: readonly {
      readonly ledger_entries: readonly { readonly kind: string }[];
    }[];
  };
  deepEqual(JSON.parse(generatedText), expected);
  equal(expected.format, "AXIOM-CONTROL-FLOW-CONFORMANCE/0.2");
  ok(expected.frozen);
  for (const execution of expected.executions) {
    ok(execution.ledger_entries.some((entry) => entry.kind === "branch"));
    ok(execution.ledger_entries.some((entry) => entry.kind === "loop"));
  }
});
