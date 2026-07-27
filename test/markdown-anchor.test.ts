import {
  doesNotThrow,
  equal,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { test, type TestContext } from "node:test";

import { canonicalJson } from "../src/canonical.ts";
import type { SourceDecl } from "../src/ast.ts";
import {
  assertMarkdownMapMatchesSource,
  importMarkdown,
  MarkdownMapError,
  validateMarkdownCoverageMap,
  type MarkdownCoverageMap,
} from "../src/markdown.ts";
import { parse } from "../src/parser.ts";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
  });
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axiom-markdown-anchor-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function sourceDeclaration(axSource: string): SourceDecl {
  const declaration = parse(axSource, "imported.ax").declarations.find(
    (candidate): candidate is SourceDecl => candidate.kind === "SourceDecl",
  );
  ok(declaration !== undefined);
  return declaration;
}

async function writeImportedProgram(
  directory: string,
  stem: string,
  bytes: Uint8Array,
): Promise<{
  readonly axPath: string;
  readonly mapPath: string;
  readonly imported: ReturnType<typeof importMarkdown>;
}> {
  const axPath = join(directory, `${stem}.ax`);
  const mapPath = join(directory, `${stem}.axmap.json`);
  const imported = importMarkdown(bytes, {
    sourcePath: `${stem}.md`,
    axPath,
    mapPath: `${stem}.axmap.json`,
  });
  await Promise.all([
    writeFile(axPath, imported.axSource, "utf8"),
    writeFile(mapPath, `${canonicalJson(imported.map)}\n`, "utf8"),
  ]);
  return { axPath, mapPath, imported };
}

test("strict AXMAP validation recomputes source and every coverage field", () => {
  const imported = importMarkdown(Buffer.from("# Rule\nDo it.\n", "utf8"), {
    sourcePath: "rules.md",
    axPath: "rules.ax",
    mapPath: "rules.axmap.json",
  });

  equal(validateMarkdownCoverageMap(imported.map), imported.map);

  const extraProperty = structuredClone(imported.map) as MarkdownCoverageMap & {
    ignored?: boolean;
  };
  extraProperty.ignored = true;
  throws(
    () => validateMarkdownCoverageMap(extraProperty),
    (error: unknown) => {
      ok(error instanceof MarkdownMapError);
      match(error.message, /ignored.*unexpected property/u);
      return true;
    },
  );

  const alteredCoverage = structuredClone(imported.map) as unknown as {
    coverage: {
      spans: Array<{ category: string }>;
    };
  };
  const first = alteredCoverage.coverage.spans[0];
  ok(first !== undefined);
  first.category = "prose";
  throws(
    () => validateMarkdownCoverageMap(alteredCoverage),
    (error: unknown) => {
      ok(error instanceof MarkdownMapError);
      match(error.message, /compiler-derived partition/u);
      return true;
    },
  );

  const alteredSource = structuredClone(imported.map) as {
    source: { base64: string };
  };
  alteredSource.source.base64 = Buffer.from("different\n", "utf8").toString(
    "base64",
  );
  throws(
    () => validateMarkdownCoverageMap(alteredSource),
    (error: unknown) => {
      ok(error instanceof MarkdownMapError);
      match(error.message, /byte_length|sha256/u);
      return true;
    },
  );
});

test("an AXMAP is cryptographically linked to its source declaration", () => {
  const imported = importMarkdown(Buffer.from("Rule\n", "utf8"), {
    sourcePath: "rules.md",
    axPath: "rules.ax",
    mapPath: "rules.axmap.json",
  });
  const map = validateMarkdownCoverageMap(imported.map);
  const source = sourceDeclaration(imported.axSource);

  doesNotThrow(() => assertMarkdownMapMatchesSource(map, source));
  throws(
    () =>
      assertMarkdownMapMatchesSource(map, {
        ...source,
        hash: `sha256:${"0".repeat(64)}`,
      }),
    (error: unknown) => {
      ok(error instanceof MarkdownMapError);
      match(error.message, /source hash/u);
      return true;
    },
  );
});

test("all .ax CLI load paths reject deleting the source and its dispositions", async (t) => {
  const directory = await temporaryDirectory(t);
  const { axPath } = await writeImportedProgram(
    directory,
    "rules",
    Buffer.from("# Rule\nDo it.\n", "utf8"),
  );
  await writeFile(axPath, "axiom 0.1;\n", "utf8");

  const inputPath = join(directory, "input.json");
  const fixturesPath = join(directory, "fixtures.json");
  const ledgerPath = join(directory, "missing.axlog");
  await Promise.all([
    writeFile(inputPath, "{}\n", "utf8"),
    writeFile(fixturesPath, "{}\n", "utf8"),
  ]);

  const invocations: ReadonlyArray<readonly string[]> = [
    ["check", axPath],
    ["compile", axPath, "-o", join(directory, "rules.air")],
    [
      "run",
      axPath,
      "--task",
      "Missing",
      "--input",
      inputPath,
      "--fixtures",
      fixturesPath,
    ],
    [
      "frame",
      axPath,
      "--task",
      "Missing",
      "--input",
      inputPath,
      "--fixtures",
      fixturesPath,
    ],
    [
      "replay",
      axPath,
      "--task",
      "Missing",
      "--input",
      inputPath,
      "--ledger",
      ledgerPath,
    ],
  ];

  for (const invocation of invocations) {
    const result = runCli(invocation);
    equal(result.status, 2, invocation[0]);
    match(
      result.stderr,
      /expects source declaration "markdown_source", but that declaration is missing/u,
      invocation[0],
    );
  }
});

test("source declarations require their named sidecars even when none is adjacent", async (t) => {
  const directory = await temporaryDirectory(t);
  const axPath = join(directory, "program.ax");
  const imported = importMarkdown(Buffer.from("\n", "utf8"), {
    sourcePath: "blank.md",
    axPath,
    mapPath: "required.anchor.json",
  });
  await writeFile(axPath, imported.axSource, "utf8");

  const result = runCli(["check", axPath]);
  equal(result.status, 2);
  match(result.stderr, /Required AXMAP\/0\.1 sidecar .* is missing/u);
});

test("--map makes a non-adjacent provenance anchor mandatory", async (t) => {
  const directory = await temporaryDirectory(t);
  const axPath = join(directory, "program.ax");
  const mapPath = join(directory, "external", "rules.anchor.json");
  const imported = importMarkdown(Buffer.from("Rule\n", "utf8"), {
    sourcePath: "rules.md",
    axPath,
    mapPath: "rules.anchor.json",
  });
  await writeFile(axPath, "axiom 0.1;\n", "utf8");
  await mkdir(join(directory, "external"));
  await writeFile(mapPath, `${canonicalJson(imported.map)}\n`, "utf8");

  const result = runCli(["check", axPath, "--map", mapPath]);
  equal(result.status, 2);
  match(
    result.stderr,
    /expects source declaration "markdown_source", but that declaration is missing/u,
  );
});

test("CLI sidecar reads reject duplicate JSON members", async (t) => {
  const directory = await temporaryDirectory(t);
  const axPath = join(directory, "program.ax");
  const mapPath = join(directory, "program.axmap.json");
  await Promise.all([
    writeFile(axPath, "axiom 0.1;\n", "utf8"),
    writeFile(
      mapPath,
      '{"format":"AXMAP/0.1","format":"AXMAP/0.1"}\n',
      "utf8",
    ),
  ]);

  const result = runCli(["check", axPath]);
  equal(result.status, 2);
  match(result.stderr, /duplicate key "format"/u);
});
