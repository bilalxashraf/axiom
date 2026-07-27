import {
  deepEqual,
  equal,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import {
  compileSource,
  reviewDispositionsHash,
  reviewFormalSemanticsHash,
} from "../src/compiler.ts";
import type { ResolvedDecl } from "../src/ast.ts";
import { CheckError, ParseError } from "../src/errors.ts";
import { importMarkdown } from "../src/markdown.ts";
import { parse } from "../src/parser.ts";

const imported = importMarkdown(
  Buffer.from("# Rules\nYou must inspect before editing.\n", "utf8"),
  {
    sourcePath: "AGENTS.md",
    axPath: "AGENTS.ax",
    mapPath: "AGENTS.axmap.json",
  },
);
const headingSpan = imported.map.coverage.spans[0];
const requirementSpan = imported.map.coverage.spans[1];
if (headingSpan === undefined || requirementSpan === undefined) {
  throw new Error("Expected two compiler-derived Markdown spans");
}

function resolutionAnchor(
  span: NonNullable<typeof headingSpan>,
  source = "markdown_source",
  id = span.id,
): string {
  return (
    `resolved ${id} source ${source} ` +
    `bytes ${span.byte_start} ${span.byte_end} hash "${span.sha256}"`
  );
}

const formalRequirement = `
proposition Reviewed event;

task Review() -> Unit
must {
  inspect_first: Reviewed;
}
{
  fail "Review fixture is not executed.";
}
`;

const nonNormativeResolution =
  `${resolutionAnchor(headingSpan)} as non_normative ` +
  'reason "Section heading only.";';
const requirementResolution =
  `${resolutionAnchor(requirementSpan)} as requirement ` +
  'task Review obligation inspect_first reason "Linked by a human reviewer.";';

function reviewSeal(
  resolutions: readonly string[],
  source = "markdown_source",
  sourceHash = imported.map.source.sha256,
  formalSource = formalRequirement,
): string {
  const declarations = parse(
    `axiom 0.1;\n${formalSource}\n${resolutions.join("\n")}\n`,
  ).declarations;
  const resolved = declarations.filter(
    (declaration): declaration is ResolvedDecl =>
      declaration.kind === "ResolvedDecl",
  );
  const tasks = declarations.filter(
    (declaration) => declaration.kind === "TaskDecl",
  );
  const propositions = new Map(
    declarations.flatMap((declaration) =>
      declaration.kind === "PropositionDecl"
        ? [[declaration.name, declaration.mode] as const]
        : [],
    ),
  );
  const formalProgram = compileSource(
    `axiom 0.1;\n${formalSource}\n`,
    "formal-review-target.ax",
  ).program;
  const formalHash = reviewFormalSemanticsHash(formalProgram);
  return (
    `review ${source} source_hash "${sourceHash}" ` +
    `dispositions_hash "${reviewDispositionsHash(
      source,
      resolved,
      (taskName, obligationId) => {
        const task = tasks.find((candidate) => candidate.name === taskName);
        const obligation = task?.obligations.find(
          (candidate) => candidate.id === obligationId,
        );
        if (
          obligation?.proposition.kind !== "NamedType" ||
          obligation.proposition.arguments.length !== 0
        ) {
          return undefined;
        }
        const proposition = obligation.proposition.name;
        const mode = propositions.get(proposition);
        return mode === undefined
          ? undefined
          : { proposition, mode, formalHash };
      },
    )}";`
  );
}

function withoutUnresolvedDeclarations(
  source = imported.axSource,
): string {
  return source
    .split("\n")
    .filter((line) => !line.startsWith("unresolved "))
    .join("\n");
}

function fullyResolvedSource(
  resolutions: readonly string[] = [
    nonNormativeResolution,
    requirementResolution,
  ],
): string {
  return [
    withoutUnresolvedDeclarations(),
    formalRequirement,
    ...resolutions,
    reviewSeal(resolutions),
    "",
  ].join("\n");
}

function expectCheckError(
  source: string,
  code: string,
  message?: RegExp,
): void {
  throws(
    () => compileSource(source, "reviewed-markdown.ax"),
    (error: unknown) => {
      ok(error instanceof CheckError);
      equal(error.code, code);
      if (message !== undefined) {
        match(error.message, message);
      }
      return true;
    },
  );
}

test("parser represents dispositions and a source-wide review seal", () => {
  const seal = reviewSeal([
    requirementResolution,
    nonNormativeResolution,
  ]);
  const ast = parse(`
axiom 0.1;
${requirementResolution}
${nonNormativeResolution}
${seal}
`);
  const requirement = ast.declarations[0];
  const nonNormative = ast.declarations[1];
  const review = ast.declarations[2];

  ok(requirement?.kind === "ResolvedDecl");
  if (requirement.disposition !== "requirement") {
    throw new Error("Expected a requirement resolution");
  }
  deepEqual(
    {
      name: requirement.name,
      source: requirement.source,
      byteStart: requirement.byteStart,
      byteEnd: requirement.byteEnd,
      hash: requirement.hash,
      disposition: requirement.disposition,
      task: requirement.task,
      obligation: requirement.obligation,
      reason: requirement.reason,
    },
    {
      name: "span_000002",
      source: "markdown_source",
      byteStart: requirementSpan.byte_start,
      byteEnd: requirementSpan.byte_end,
      hash: requirementSpan.sha256,
      disposition: "requirement",
      task: "Review",
      obligation: "inspect_first",
      reason: "Linked by a human reviewer.",
    },
  );

  ok(nonNormative?.kind === "ResolvedDecl");
  equal(nonNormative.disposition, "non_normative");
  equal(nonNormative.name, "span_000001");
  equal(nonNormative.source, "markdown_source");
  equal(nonNormative.byteStart, headingSpan.byte_start);
  equal(nonNormative.byteEnd, headingSpan.byte_end);
  equal(nonNormative.hash, headingSpan.sha256);
  equal(nonNormative.reason, "Section heading only.");

  ok(review?.kind === "ReviewDecl");
  equal(review.source, "markdown_source");
  equal(review.sourceHash, imported.map.source.sha256);
  equal(
    review.dispositionsHash,
    reviewDispositionsHash(
      "markdown_source",
      [requirement, nonNormative],
      (taskName, obligationId) =>
        taskName === "Review" && obligationId === "inspect_first"
          ? {
              proposition: "Reviewed",
              mode: "event",
              formalHash: reviewFormalSemanticsHash(
                compileSource(
                  `axiom 0.1;\n${formalRequirement}\n`,
                ).program,
              ),
            }
          : undefined,
    ),
  );
});

test("fully reviewed Markdown compiles and provenance is omitted from AIR", () => {
  const compiled = compileSource(
    fullyResolvedSource(),
    "reviewed-markdown.ax",
  );

  equal(compiled.program.tasks.length, 1);
  equal(compiled.program.tasks[0]?.name, "Review");
  equal(compiled.program.propositions.length, 1);
  deepEqual(Object.keys(compiled.program).sort(), [
    "format",
    "language",
    "ports",
    "propositions",
    "records",
    "sourceHash",
    "tasks",
  ]);

  const air = JSON.stringify(compiled.program);
  equal(air.includes("span_000001"), false);
  equal(air.includes("span_000002"), false);
  equal(air.includes("AGENTS.md"), false);
  equal(air.includes("Section heading only."), false);
});

test("a mixed review remains blocked while any span is unresolved", () => {
  const mixed = [
    imported.axSource.replace(
      /^unresolved md_000001 .*;$/mu,
      nonNormativeResolution,
    ),
    formalRequirement,
  ].join("\n");

  expectCheckError(
    mixed,
    "AX1000",
    /Unresolved imported clause `md_000002`/u,
  );
});

test("coverage requires exactly one disposition for every nonblank span", () => {
  expectCheckError(
    fullyResolvedSource([nonNormativeResolution]),
    "AX1030",
    /requires 2 reviewed nonblank span dispositions, found 1/u,
  );

  const dualDisposition = [
    imported.axSource,
    formalRequirement,
    nonNormativeResolution,
  ].join("\n");
  expectCheckError(
    dualDisposition,
    "AX1038",
    /both unresolved and resolved dispositions for span `span_000001`/u,
  );

  expectCheckError(
    fullyResolvedSource([
      nonNormativeResolution,
      requirementResolution.replace("span_000002", "span_999999"),
    ]),
    "AX1037",
    /does not match a compiler-derived nonblank span/u,
  );
});

test("reviewed spans are content-bound across source reordering", () => {
  const reordered = importMarkdown(
    Buffer.from("You must inspect before editing.\n# Rules\n", "utf8"),
    {
      sourcePath: "AGENTS.md",
      axPath: "AGENTS.ax",
      mapPath: "AGENTS.axmap.json",
    },
  );
  const staleReview = [
    withoutUnresolvedDeclarations(reordered.axSource),
    formalRequirement,
    // These are the exact review records for the original ordering. Their
    // ordinal IDs still exist, but their byte ranges and hashes are now stale.
    nonNormativeResolution,
    requirementResolution,
    "",
  ].join("\n");

  expectCheckError(
    staleReview,
    "AX1041",
    /imported text changed and must be reviewed again/u,
  );
});

test("a source-wide review seal invalidates unchanged spans after contextual edits", () => {
  const original = importMarkdown(
    Buffer.from("Mode: enforce.\nDelete temporary files.\n", "utf8"),
    {
      sourcePath: "POLICY.md",
      axPath: "POLICY.ax",
      mapPath: "POLICY.axmap.json",
    },
  );
  const changed = importMarkdown(
    Buffer.from("Mode: example.\nDelete temporary files.\n", "utf8"),
    {
      sourcePath: "POLICY.md",
      axPath: "POLICY.ax",
      mapPath: "POLICY.axmap.json",
    },
  );
  const originalMode = original.map.coverage.spans[0];
  const originalInstruction = original.map.coverage.spans[1];
  const changedMode = changed.map.coverage.spans[0];
  if (
    originalMode === undefined ||
    originalInstruction === undefined ||
    changedMode === undefined
  ) {
    throw new Error("Expected context and instruction spans");
  }
  const originalModeResolution =
    `${resolutionAnchor(originalMode)} as non_normative ` +
    'reason "Original enforcement mode label.";';
  const originalInstructionResolution =
    `${resolutionAnchor(originalInstruction)} as requirement ` +
    'task Review obligation inspect_first reason "Enforced instruction.";';
  const changedModeResolution =
    `${resolutionAnchor(changedMode)} as non_normative ` +
    'reason "Changed example mode label.";';
  const staleSeal = reviewSeal(
    [originalModeResolution, originalInstructionResolution],
    "markdown_source",
    original.map.source.sha256,
  );
  const source = [
    withoutUnresolvedDeclarations(changed.axSource),
    formalRequirement,
    changedModeResolution,
    originalInstructionResolution,
    staleSeal,
    "",
  ].join("\n");

  expectCheckError(
    source,
    "AX1043",
    /complete source must be reviewed again/u,
  );
});

test("a review seal binds the formal proposition behind an obligation ID", () => {
  const oldSeal = reviewSeal([
    nonNormativeResolution,
    requirementResolution,
  ]);
  const changedFormalRequirement = formalRequirement
    .replace("proposition Reviewed event;", "proposition ChangedMeaning state;")
    .replace("inspect_first: Reviewed;", "inspect_first: ChangedMeaning;");
  const source = [
    withoutUnresolvedDeclarations(),
    changedFormalRequirement,
    nonNormativeResolution,
    requirementResolution,
    oldSeal,
    "",
  ].join("\n");

  expectCheckError(
    source,
    "AX1044",
    /does not match the canonical disposition set/u,
  );
});

test("a review seal binds the complete formal task and port semantics", () => {
  const oldSeal = reviewSeal([
    nonNormativeResolution,
    requirementResolution,
  ]);
  const changedFormalRequirement = formalRequirement.replace(
    '  fail "Review fixture is not executed.";',
    '  assert true;\n  fail "Review fixture is not executed.";',
  );
  const source = [
    withoutUnresolvedDeclarations(),
    changedFormalRequirement,
    nonNormativeResolution,
    requirementResolution,
    oldSeal,
    "",
  ].join("\n");

  expectCheckError(
    source,
    "AX1044",
    /does not match the canonical disposition set/u,
  );
});

test("fully dispositioned imported sources require one exact review seal", () => {
  const resolutions = [
    nonNormativeResolution,
    requirementResolution,
  ];
  const withoutSeal = [
    withoutUnresolvedDeclarations(),
    formalRequirement,
    ...resolutions,
    "",
  ].join("\n");
  expectCheckError(
    withoutSeal,
    "AX1042",
    /lacks a source-wide review seal/u,
  );

  const wrongDispositions = [
    withoutUnresolvedDeclarations(),
    formalRequirement,
    ...resolutions,
    reviewSeal(resolutions).replace(
      /dispositions_hash "sha256:[0-9a-f]{64}"/u,
      `dispositions_hash "sha256:${"f".repeat(64)}"`,
    ),
    "",
  ].join("\n");
  expectCheckError(
    wrongDispositions,
    "AX1044",
    /does not match the canonical disposition set/u,
  );

  expectCheckError(
    `${fullyResolvedSource()}\n${reviewSeal(resolutions)}\n`,
    "AX1045",
    /Duplicate review seal/u,
  );
});

test("resolved declarations use the shared declaration namespace", () => {
  expectCheckError(
    [
      imported.axSource,
      `${resolutionAnchor(headingSpan, "markdown_source", "md_000001")} ` +
        `as non_normative reason "Duplicate name.";`,
    ].join("\n"),
    "AX1001",
    /Duplicate declaration `md_000001`/u,
  );

  expectCheckError(
    fullyResolvedSource([
      `${resolutionAnchor(headingSpan, "markdown_source", "markdown_source")} ` +
        `as non_normative reason "Conflicts with source ID.";`,
      requirementResolution,
    ]),
    "AX1001",
    /Duplicate declaration `markdown_source`/u,
  );
});

test("requirement resolutions must target a declared task obligation", () => {
  expectCheckError(
    fullyResolvedSource([
      nonNormativeResolution,
      requirementResolution.replace("task Review", "task Missing"),
    ]),
    "AX1035",
    /unknown task `Missing`/u,
  );

  expectCheckError(
    fullyResolvedSource([
      nonNormativeResolution,
      requirementResolution.replace(
        "obligation inspect_first",
        "obligation missing",
      ),
    ]),
    "AX1036",
    /has no obligation `missing`/u,
  );
});

test("resolution source links and non-normative reasons fail closed", () => {
  expectCheckError(
    fullyResolvedSource([
      nonNormativeResolution.replace(
        "source markdown_source",
        "source missing_source",
      ),
      requirementResolution,
    ]),
    "AX1033",
    /unknown imported source `missing_source`/u,
  );

  expectCheckError(
    fullyResolvedSource([
      `${resolutionAnchor(headingSpan)} as non_normative reason "";`,
      requirementResolution,
    ]),
    "AX1034",
    /non-empty review reason/u,
  );

  expectCheckError(
    fullyResolvedSource([
      nonNormativeResolution,
      requirementResolution.replace(
        '"Linked by a human reviewer."',
        '""',
      ),
    ]),
    "AX1034",
    /non-empty review reason/u,
  );
});

test("parser gives specific diagnostics for malformed review syntax", () => {
  throws(
    () =>
      parse(`
axiom 0.1;
${resolutionAnchor(headingSpan)} as ignored reason "No.";
`),
    (error: unknown) => {
      ok(error instanceof ParseError);
      equal(error.code, "A241");
      match(error.message, /expected `requirement` or `non_normative`/u);
      return true;
    },
  );

  throws(
    () =>
      parse(`
axiom 0.1;
${resolutionAnchor(headingSpan)} as requirement task Review reason "Missing link.";
`),
    (error: unknown) => {
      ok(error instanceof ParseError);
      equal(error.code, "A233");
      match(error.message, /keyword "obligation"/u);
      return true;
    },
  );

  throws(
    () =>
      parse(`
axiom 0.1;
${resolutionAnchor(headingSpan)} as non_normative reason 7;
`),
    (error: unknown) => {
      ok(error instanceof ParseError);
      equal(error.code, "A234");
      match(error.message, /non-normative review reason string/u);
      return true;
    },
  );
});

test("multiple imported Markdown sources use collision-free span identifiers", () => {
  const first = importMarkdown(Buffer.from("First requirement.\n"), {
    sourcePath: "FIRST.md",
    axPath: "combined.ax",
    mapPath: "FIRST.axmap.json",
    sourceId: "first_guide",
  });
  const second = importMarkdown(Buffer.from("Second requirement.\n"), {
    sourcePath: "SECOND.md",
    axPath: "combined.ax",
    mapPath: "SECOND.axmap.json",
    sourceId: "second_guide",
  });
  const firstSpan = first.map.coverage.spans[0];
  const secondSpan = second.map.coverage.spans[0];
  if (firstSpan === undefined || secondSpan === undefined) {
    throw new Error("Expected one compiler-derived span per imported source");
  }
  const provenance = [first.axSource, second.axSource]
    .flatMap((source) => source.split("\n"))
    .filter(
      (line) =>
        line !== "axiom 0.1;" &&
        !line.startsWith("unresolved ") &&
        !line.startsWith("//"),
    )
    .join("\n");
  const source = `
axiom 0.1;
${provenance}

proposition FirstDone event;
proposition SecondDone event;

task First() -> Unit must { first: FirstDone; } {
  fail "not executed";
}
task Second() -> Unit must { second: SecondDone; } {
  fail "not executed";
}

${resolutionAnchor(firstSpan, "first_guide")} as requirement
  task First obligation first reason "Reviewed first source.";
${resolutionAnchor(secondSpan, "second_guide")} as requirement
  task Second obligation second reason "Reviewed second source.";
${reviewSeal(
  [
    `${resolutionAnchor(firstSpan, "first_guide")} as requirement ` +
      `task First obligation first reason "Reviewed first source.";`,
  ],
  "first_guide",
  first.map.source.sha256,
  `
proposition FirstDone event;
proposition SecondDone event;
task First() -> Unit must { first: FirstDone; } { fail "not executed"; }
task Second() -> Unit must { second: SecondDone; } { fail "not executed"; }
`,
)}
${reviewSeal(
  [
    `${resolutionAnchor(secondSpan, "second_guide")} as requirement ` +
      `task Second obligation second reason "Reviewed second source.";`,
  ],
  "second_guide",
  second.map.source.sha256,
  `
proposition FirstDone event;
proposition SecondDone event;
task First() -> Unit must { first: FirstDone; } { fail "not executed"; }
task Second() -> Unit must { second: SecondDone; } { fail "not executed"; }
`,
)}
`;
  const compiled = compileSource(source, "combined.ax");
  equal(compiled.program.tasks.length, 2);
  equal(
    first.map.coverage.spans[0]?.id,
    "first_guide_span_000001",
  );
  equal(
    second.map.coverage.spans[0]?.id,
    "second_guide_span_000001",
  );
});
