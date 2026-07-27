import type {
  CallExpr,
  Decl,
  Expr,
  ExternDecl,
  Program,
  RecordDecl,
  ResolvedDecl,
  ReviewDecl,
  SourceDecl,
  Stmt,
  TaskDecl,
  TypeNode,
  UnresolvedDecl,
} from "./ast.ts";
import { verifyAirProgram } from "./air-validator.ts";
import {
  canonicalHash,
  canonicalJsonBytes,
  sha256Bytes,
  sha256Text,
  unicodeScalarLength,
  type Sha256,
} from "./canonical.ts";
import { CheckError } from "./errors.ts";
import type {
  AirExpr,
  AirObligation,
  AirOp,
  AirParameter,
  AirPort,
  AirProgram,
  AirProposition,
  AirRecord,
  AirTask,
  AirType,
  CompiledProgram,
  PropositionMode,
} from "./ir.ts";
import { MAX_AXIP_TEXT_SCALARS } from "./limits.ts";
import { parse } from "./parser.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "./program-hash.ts";
import { analyzeMarkdownCoverage } from "./markdown.ts";
import { typeEquals, typeToString } from "./types.ts";

type Binding = {
  readonly type: AirType;
};

type ObligationState = {
  readonly proposition: string;
  status: "pending" | "satisfied";
};

const BUILTIN_TYPES = new Set(["Bool", "Int", "Text", "Bytes", "Unit", "Json"]);

function checkError(code: string, message: string, node: { readonly span: { readonly start: { readonly offset: number; readonly line: number; readonly column: number } } }): never {
  throw new CheckError(code, message, node.span.start);
}

function namedType(name: string): AirType {
  return { kind: "named", name };
}

function containsCandidate(type: AirType): boolean {
  switch (type.kind) {
    case "candidate":
      return true;
    case "list":
      return containsCandidate(type.element);
    case "named":
    case "evidence":
      return false;
  }
}

function containsEvidence(type: AirType): boolean {
  switch (type.kind) {
    case "evidence":
      return true;
    case "candidate":
      return containsEvidence(type.value);
    case "list":
      return containsEvidence(type.element);
    case "named":
      return false;
  }
}

function propositionName(type: TypeNode): string {
  if (type.kind !== "NamedType" || type.arguments.length !== 0) {
    checkError("AX1101", "A proposition must be a non-parameterized named type", type);
  }
  return type.name;
}

function callParts(expression: Expr, statement: Stmt): { readonly name: string; readonly call: CallExpr } {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "RefExpr") {
    checkError("AX1102", "Effect statements require a direct call to a declared port", statement);
  }
  return { name: expression.callee.name, call: expression };
}

function literalMessage(expression: Expr, statement: Stmt): string {
  if (expression.kind !== "LiteralExpr" || typeof expression.value !== "string") {
    checkError("AX1103", "Failure reasons must be string literals", statement);
  }
  return expression.value;
}

function checkedTextLength(
  value: string,
  label: string,
  node: { readonly span: { readonly start: { readonly offset: number; readonly line: number; readonly column: number } } },
): number {
  try {
    return unicodeScalarLength(value);
  } catch {
    checkError(
      "AX1050",
      `${label} must contain only Unicode scalar values`,
      node,
    );
  }
}

class Compiler {
  readonly source: string;
  readonly ast: Program;
  readonly sources = new Map<string, SourceDecl>();
  readonly sourceBytes = new Map<string, Uint8Array>();
  readonly unresolved = new Map<string, UnresolvedDecl>();
  readonly resolved = new Map<string, ResolvedDecl>();
  readonly reviews = new Map<string, ReviewDecl>();
  readonly records = new Map<string, RecordDecl>();
  readonly propositions = new Map<string, PropositionMode>();
  readonly externs = new Map<string, ExternDecl>();
  readonly tasks = new Map<string, TaskDecl>();

  constructor(source: string, ast: Program) {
    this.source = source;
    this.ast = ast;
  }

  compile(): CompiledProgram {
    this.collectDeclarations();
    const program: AirProgram = {
      format: "AIR/0.1",
      language: this.ast.version,
      sourceHash: sha256Text(this.source),
      records: [...this.records.values()].map((record) => this.lowerRecord(record)),
      propositions: [...this.propositions.entries()].map(
        ([name, mode]): AirProposition => ({ name, mode }),
      ),
      ports: [...this.externs.values()].map((external) => this.lowerPort(external)),
      tasks: [...this.tasks.values()].map((task) => this.lowerTask(task)),
    };
    verifyAirProgram(program);
    const bytes = canonicalJsonBytes(program);
    return {
      hash: semanticProgramHash(program),
      artifactHash: artifactProgramHash(program),
      bytes,
      program,
    };
  }

  private collectDeclarations(): void {
    for (const declaration of this.ast.declarations) {
      if (declaration.kind === "ReviewDecl") {
        if (this.reviews.has(declaration.source)) {
          checkError(
            "AX1045",
            `Duplicate review seal for imported source \`${declaration.source}\``,
            declaration,
          );
        }
        this.reviews.set(declaration.source, declaration);
        continue;
      }
      const name = declaration.name;
      if (
        this.sources.has(name) ||
        this.unresolved.has(name) ||
        this.resolved.has(name) ||
        this.records.has(name) ||
        this.propositions.has(name) ||
        this.externs.has(name) ||
        this.tasks.has(name) ||
        BUILTIN_TYPES.has(name)
      ) {
        checkError("AX1001", `Duplicate declaration \`${name}\``, declaration);
      }
      switch (declaration.kind) {
        case "SourceDecl":
          this.sources.set(name, declaration);
          break;
        case "UnresolvedDecl":
          this.unresolved.set(name, declaration);
          break;
        case "ResolvedDecl":
          this.resolved.set(name, declaration);
          break;
        case "RecordDecl":
          this.records.set(name, declaration);
          break;
        case "PropositionDecl":
          this.propositions.set(name, declaration.mode);
          break;
        case "ExternDecl":
          this.externs.set(name, declaration);
          break;
        case "TaskDecl":
          this.tasks.set(name, declaration);
          break;
      }
    }
    for (const declaration of this.ast.declarations) {
      this.checkDeclarationTypes(declaration);
    }
    this.checkImportedCoverage();
    const firstUnresolved = this.unresolved.values().next().value as
      | UnresolvedDecl
      | undefined;
    if (firstUnresolved !== undefined) {
      checkError(
        "AX1000",
        `Unresolved imported clause \`${firstUnresolved.name}\` from ` +
          `\`${firstUnresolved.source}\` bytes ${firstUnresolved.byteStart}..${firstUnresolved.byteEnd}; ` +
          "resolve or explicitly classify the source span before strict compilation",
        firstUnresolved,
      );
    }
  }

  private checkDeclarationTypes(declaration: Decl): void {
    switch (declaration.kind) {
      case "SourceDecl":
        if (!/^sha256:[0-9a-f]{64}$/u.test(declaration.hash)) {
          checkError("AX1020", "A source declaration requires a lowercase SHA-256 hash", declaration);
        }
        if (!Number.isSafeInteger(declaration.byteLength) || declaration.byteLength < 0) {
          checkError("AX1021", "A source byte length must be a non-negative safe integer", declaration);
        }
        {
          const decoded = Buffer.from(declaration.base64, "base64");
          if (decoded.toString("base64") !== declaration.base64) {
            checkError("AX1026", "A source declaration requires canonical RFC 4648 base64", declaration);
          }
          if (decoded.byteLength !== declaration.byteLength) {
            checkError(
              "AX1027",
              `Embedded source has ${decoded.byteLength} bytes, expected ${declaration.byteLength}`,
              declaration,
            );
          }
          if (sha256Bytes(decoded) !== declaration.hash) {
            checkError("AX1028", "Embedded source bytes do not match the declared SHA-256 hash", declaration);
          }
          this.sourceBytes.set(declaration.name, decoded);
        }
        break;
      case "UnresolvedDecl": {
        const source = this.sources.get(declaration.source);
        if (source === undefined) {
          checkError("AX1022", `Unknown imported source \`${declaration.source}\``, declaration);
        }
        if (
          !Number.isSafeInteger(declaration.byteStart) ||
          !Number.isSafeInteger(declaration.byteEnd) ||
          declaration.byteStart < 0 ||
          declaration.byteEnd <= declaration.byteStart ||
          declaration.byteEnd > source.byteLength
        ) {
          checkError(
            "AX1023",
            `Unresolved source span must be non-empty and within 0..${source.byteLength}`,
            declaration,
          );
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(declaration.hash)) {
          checkError("AX1024", "An unresolved declaration requires a lowercase SHA-256 hash", declaration);
        }
        if (declaration.category.length === 0 || declaration.reason.length === 0) {
          checkError("AX1025", "An unresolved declaration requires a category and reason", declaration);
        }
        break;
      }
      case "ResolvedDecl": {
        const source = this.sources.get(declaration.source);
        if (source === undefined) {
          checkError(
            "AX1033",
            `Resolved span \`${declaration.name}\` refers to unknown imported source \`${declaration.source}\``,
            declaration,
          );
        }
        if (
          !Number.isSafeInteger(declaration.byteStart) ||
          !Number.isSafeInteger(declaration.byteEnd) ||
          declaration.byteStart < 0 ||
          declaration.byteEnd <= declaration.byteStart ||
          declaration.byteEnd > source.byteLength
        ) {
          checkError(
            "AX1039",
            `Resolved source span must be non-empty and within 0..${source.byteLength}`,
            declaration,
          );
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(declaration.hash)) {
          checkError(
            "AX1040",
            "A resolved declaration requires a lowercase SHA-256 hash",
            declaration,
          );
        }
        if (declaration.reason.length === 0) {
          checkError(
            "AX1034",
            "Every resolution requires a non-empty review reason",
            declaration,
          );
        }
        if (declaration.disposition === "non_normative") {
          break;
        }
        const task = this.tasks.get(declaration.task);
        if (task === undefined) {
          checkError(
            "AX1035",
            `Resolved requirement \`${declaration.name}\` refers to unknown task \`${declaration.task}\``,
            declaration,
          );
        }
        if (
          !task.obligations.some(
            (obligation) => obligation.id === declaration.obligation,
          )
        ) {
          checkError(
            "AX1036",
            `Task \`${declaration.task}\` has no obligation \`${declaration.obligation}\``,
            declaration,
          );
        }
        break;
      }
      case "ReviewDecl": {
        if (!this.sources.has(declaration.source)) {
          checkError(
            "AX1042",
            `Review seal refers to unknown imported source \`${declaration.source}\``,
            declaration,
          );
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(declaration.sourceHash)) {
          checkError(
            "AX1043",
            "A review seal requires a lowercase source SHA-256 hash",
            declaration,
          );
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(declaration.dispositionsHash)) {
          checkError(
            "AX1044",
            "A review seal requires a lowercase dispositions SHA-256 hash",
            declaration,
          );
        }
        break;
      }
      case "RecordDecl":
        for (const field of declaration.fields) {
          const fieldType = this.lowerType(field.type);
          if (containsCandidate(fieldType)) {
            checkError(
              "AX1019",
              "Candidate values cannot be stored in record fields",
              field,
            );
          }
          if (containsEvidence(fieldType)) {
            checkError(
              "AX1044",
              "Evidence is linear runtime proof and cannot be stored in record fields",
              field,
            );
          }
        }
        break;
      case "PropositionDecl":
        if (declaration.parameters.length !== 0) {
          checkError("AX1002", "Parameterized propositions are not part of Axiom Core 0.1", declaration);
        }
        break;
      case "ExternDecl":
        for (const parameter of declaration.parameters) {
          const parameterType = this.lowerType(parameter.type);
          if (containsEvidence(parameterType)) {
            checkError(
              "AX1045",
              "Evidence cannot cross an external port boundary",
              parameter,
            );
          }
          if (containsCandidate(parameterType) && declaration.externKind !== "validator") {
            checkError(
              "AX1040",
              "Only validator ports may accept Candidate parameters",
              parameter,
            );
          }
          if (
            containsCandidate(parameterType) &&
            (parameterType.kind !== "candidate" ||
              containsCandidate(parameterType.value))
          ) {
            checkError(
              "AX1046",
              "A validator Candidate parameter must be top-level and cannot nest Candidate values",
              parameter,
            );
          }
        }
        if (declaration.returnType !== undefined) {
          const returnType = this.lowerType(declaration.returnType);
          if (containsCandidate(returnType)) {
            checkError(
              "AX1041",
              "External ports cannot return Candidate types explicitly; model results are wrapped automatically",
              declaration,
            );
          }
          if (containsEvidence(returnType)) {
            checkError(
              "AX1047",
              "Evidence can only be minted by `verify` and cannot be returned by a port",
              declaration,
            );
          }
        }
        if (declaration.externKind === "tool") {
          if (declaration.returnType === undefined) {
            checkError("AX1003", "Tools must declare a return type", declaration);
          }
          if (declaration.mode !== "read" && declaration.mode !== "write") {
            checkError("AX1004", "Tool mode must be `read` or `write`", declaration);
          }
        }
        if (declaration.externKind === "model") {
          if (
            declaration.returnType === undefined ||
            declaration.intent === undefined ||
            checkedTextLength(
              declaration.intent ?? "",
              "Model intent",
              declaration,
            ) === 0
          ) {
            checkError(
              "AX1005",
              "Models must declare a return type and non-empty intent",
              declaration,
            );
          }
          if (
            checkedTextLength(
              declaration.intent as string,
              "Model intent",
              declaration,
            ) > MAX_AXIP_TEXT_SCALARS
          ) {
            checkError(
              "AX1051",
              `Model intent cannot exceed ${MAX_AXIP_TEXT_SCALARS} Unicode scalar values`,
              declaration,
            );
          }
        }
        if (declaration.externKind === "validator" && declaration.returnType === undefined) {
          checkError("AX1006", "Validators must declare a return type", declaration);
        }
        if (declaration.externKind === "verifier") {
          if (declaration.proves === undefined) {
            checkError("AX1007", "Verifiers must declare the proposition they prove", declaration);
          }
          const proposition = propositionName(declaration.proves);
          if (!this.propositions.has(proposition)) {
            checkError("AX1008", `Unknown proposition \`${proposition}\``, declaration);
          }
        }
        break;
      case "TaskDecl":
        for (const parameter of declaration.parameters) {
          const parameterType = this.lowerType(parameter.type);
          if (containsCandidate(parameterType)) {
            checkError("AX1042", "Task inputs cannot be Candidate values", parameter);
          }
          if (containsEvidence(parameterType)) {
            checkError("AX1048", "Task inputs cannot contain Evidence values", parameter);
          }
        }
        const returnType = this.lowerType(declaration.returnType);
        if (containsCandidate(returnType)) {
          checkError("AX1043", "Tasks cannot return Candidate values", declaration);
        }
        if (containsEvidence(returnType)) {
          checkError("AX1049", "Tasks cannot return Evidence values", declaration);
        }
        break;
    }
  }

  private checkImportedCoverage(): void {
    for (const source of this.sources.values()) {
      const bytes = this.sourceBytes.get(source.name);
      if (bytes === undefined) {
        checkError("AX1029", "Imported source bytes were not validated", source);
      }
      const expected = analyzeMarkdownCoverage(bytes, source.name).filter(
        (span) => span.disposition.status === "unresolved",
      );
      const unresolved = [...this.unresolved.values()].filter(
        (declaration) => declaration.source === source.name,
      );
      const resolved = [...this.resolved.values()].filter(
        (declaration) => declaration.source === source.name,
      );

      // Detect dual dispositions before the aggregate count check so a review
      // cannot hide a still-live unresolved declaration for the same span.
      for (const span of expected) {
        if (span.disposition.status !== "unresolved") {
          continue;
        }
        const unresolvedDeclaration = this.unresolved.get(
          span.disposition.declaration,
        );
        const resolvedDeclaration = this.resolved.get(span.id);
        if (
          unresolvedDeclaration?.source === source.name &&
          resolvedDeclaration?.source === source.name
        ) {
          checkError(
            "AX1038",
            `Imported source \`${source.name}\` has both unresolved and resolved dispositions for span \`${span.id}\``,
            resolvedDeclaration,
          );
        }
      }

      const actualCount = unresolved.length + resolved.length;
      if (actualCount !== expected.length) {
        const legacyOnly = resolved.length === 0;
        checkError(
          "AX1030",
          legacyOnly
            ? `Imported source \`${source.name}\` requires ${expected.length} unresolved ` +
                `span${expected.length === 1 ? "" : "s"}, found ${actualCount}`
            : `Imported source \`${source.name}\` requires ${expected.length} reviewed ` +
                `nonblank span disposition${expected.length === 1 ? "" : "s"}, found ${actualCount}`,
          source,
        );
      }

      const expectedByUnresolvedName = new Map(
        expected.flatMap((span) =>
          span.disposition.status === "unresolved"
            ? [[span.disposition.declaration, span] as const]
            : [],
        ),
      );
      const expectedBySpanId = new Map(
        expected.map((span) => [span.id, span] as const),
      );
      for (const declaration of unresolved) {
        if (!expectedByUnresolvedName.has(declaration.name)) {
          checkError(
            "AX1037",
            `Unresolved declaration \`${declaration.name}\` does not match a compiler-derived nonblank span of source \`${source.name}\``,
            declaration,
          );
        }
      }
      for (const declaration of resolved) {
        if (!expectedBySpanId.has(declaration.name)) {
          checkError(
            "AX1037",
            `Resolved declaration \`${declaration.name}\` does not match a compiler-derived nonblank span of source \`${source.name}\``,
            declaration,
          );
        }
      }

      for (const span of expected) {
        if (span.disposition.status !== "unresolved") {
          continue;
        }
        const unresolvedDeclaration = this.unresolved.get(
          span.disposition.declaration,
        );
        const resolvedDeclaration = this.resolved.get(span.id);
        const matchingUnresolved =
          unresolvedDeclaration?.source === source.name
            ? unresolvedDeclaration
            : undefined;
        const matchingResolved =
          resolvedDeclaration?.source === source.name
            ? resolvedDeclaration
            : undefined;
        if (matchingUnresolved === undefined && matchingResolved === undefined) {
          checkError(
            "AX1031",
            `Missing unresolved declaration \`${span.disposition.declaration}\` or ` +
              `resolved declaration \`${span.id}\` for source \`${source.name}\` ` +
              `bytes ${span.byte_start}..${span.byte_end}`,
            source,
          );
        }
        if (
          matchingUnresolved !== undefined &&
          (matchingUnresolved.byteStart !== span.byte_start ||
            matchingUnresolved.byteEnd !== span.byte_end ||
            matchingUnresolved.hash !== span.sha256 ||
            matchingUnresolved.category !== span.category)
        ) {
          checkError(
            "AX1032",
            `Unresolved declaration \`${matchingUnresolved.name}\` does not match its ` +
              "compiler-derived source span",
            matchingUnresolved,
          );
        }
        if (
          matchingResolved !== undefined &&
          (matchingResolved.byteStart !== span.byte_start ||
            matchingResolved.byteEnd !== span.byte_end ||
            matchingResolved.hash !== span.sha256)
        ) {
          checkError(
            "AX1041",
            `Resolved declaration \`${matchingResolved.name}\` does not match its ` +
              "compiler-derived source span; imported text changed and must be reviewed again",
            matchingResolved,
          );
        }
      }

      if (unresolved.length !== 0) {
        continue;
      }
      const expectedDispositionsHash = reviewDispositionsHash(
        source.name,
        resolved,
        (taskName, obligationId) => {
          const task = this.tasks.get(taskName);
          const obligation = task?.obligations.find(
            (candidate) => candidate.id === obligationId,
          );
          if (obligation === undefined) {
            return undefined;
          }
          const proposition = propositionName(obligation.proposition);
          const mode = this.propositions.get(proposition);
          return mode === undefined
            ? undefined
            : {
                proposition,
                mode,
                formalHash: reviewFormalSemanticsHash({
                  language: this.ast.version,
                  records: [...this.records.values()].map((record) =>
                    this.lowerRecord(record),
                  ),
                  propositions: [...this.propositions.entries()].map(
                    ([name, propositionMode]): AirProposition => ({
                      name,
                      mode: propositionMode,
                    }),
                  ),
                  ports: [...this.externs.values()].map((external) =>
                    this.lowerPort(external),
                  ),
                  tasks: [...this.tasks.values()].map((formalTask) =>
                    this.lowerTask(formalTask),
                  ),
                }),
              };
        },
      );
      const review = this.reviews.get(source.name);
      // A whitespace-only source has no decisions to attest, so its seal is
      // optional. If one is present, however, it must still be truthful.
      if (expected.length === 0 && review === undefined) {
        continue;
      }
      if (review === undefined) {
        checkError(
          "AX1042",
          `Imported source \`${source.name}\` is fully dispositioned but lacks a source-wide review seal; ` +
            `after review add: review ${source.name} source_hash "${source.hash}" ` +
            `dispositions_hash "${expectedDispositionsHash}";`,
          source,
        );
      }
      if (review.sourceHash !== source.hash) {
        checkError(
          "AX1043",
          `Review seal for \`${source.name}\` targets ${review.sourceHash}, but the current source is ${source.hash}; ` +
            "the complete source must be reviewed again",
          review,
        );
      }
      if (review.dispositionsHash !== expectedDispositionsHash) {
        checkError(
          "AX1044",
          `Review seal for \`${source.name}\` does not match the canonical disposition set; ` +
            `after review use ${expectedDispositionsHash}`,
          review,
        );
      }
    }
  }

  private lowerType(type: TypeNode): AirType {
    if (type.kind === "ArrayType") {
      return { kind: "list", element: this.lowerType(type.element) };
    }
    if (type.kind === "OptionalType") {
      checkError("AX1009", "Optional types are not part of the certified 0.1 core", type);
    }
    if (type.name === "List") {
      if (type.arguments.length !== 1) {
        checkError("AX1010", "List requires exactly one type argument", type);
      }
      return { kind: "list", element: this.lowerType(type.arguments[0] as TypeNode) };
    }
    if (type.name === "Candidate") {
      if (type.arguments.length !== 1) {
        checkError("AX1011", "Candidate requires exactly one type argument", type);
      }
      return { kind: "candidate", value: this.lowerType(type.arguments[0] as TypeNode) };
    }
    if (type.name === "Evidence") {
      if (type.arguments.length !== 1) {
        checkError("AX1012", "Evidence requires exactly one proposition argument", type);
      }
      const proposition = propositionName(type.arguments[0] as TypeNode);
      if (!this.propositions.has(proposition)) {
        checkError("AX1013", `Unknown proposition \`${proposition}\``, type);
      }
      return { kind: "evidence", proposition };
    }
    if (type.arguments.length !== 0) {
      checkError("AX1014", `Type \`${type.name}\` does not accept type arguments`, type);
    }
    if (!BUILTIN_TYPES.has(type.name) && !this.records.has(type.name)) {
      checkError("AX1015", `Unknown type \`${type.name}\``, type);
    }
    return namedType(type.name);
  }

  private lowerRecord(record: RecordDecl): AirRecord {
    const seen = new Set<string>();
    return {
      name: record.name,
      fields: record.fields.map((field) => {
        if (seen.has(field.name)) {
          checkError("AX1016", `Duplicate field \`${field.name}\` in record \`${record.name}\``, field);
        }
        seen.add(field.name);
        if (field.optional) {
          checkError("AX1017", "Optional record fields are not part of Axiom Core 0.1", field);
        }
        return { name: field.name, type: this.lowerType(field.type) };
      }),
    };
  }

  private lowerParameters(external: Pick<ExternDecl | TaskDecl, "parameters">): AirParameter[] {
    const seen = new Set<string>();
    return external.parameters.map((parameter) => {
      if (seen.has(parameter.name)) {
        checkError("AX1018", `Duplicate parameter \`${parameter.name}\``, parameter);
      }
      seen.add(parameter.name);
      return { name: parameter.name, type: this.lowerType(parameter.type) };
    });
  }

  private lowerPort(external: ExternDecl): AirPort {
    const parameters = this.lowerParameters(external);
    switch (external.externKind) {
      case "tool":
        return {
          kind: "tool",
          name: external.name,
          mode: external.mode as "read" | "write",
          parameters,
          returns: this.lowerType(external.returnType as TypeNode),
        };
      case "model":
        return {
          kind: "model",
          name: external.name,
          parameters,
          returns: this.lowerType(external.returnType as TypeNode),
          intent: external.intent as string,
        };
      case "validator":
        return {
          kind: "validator",
          name: external.name,
          parameters,
          returns: this.lowerType(external.returnType as TypeNode),
        };
      case "verifier":
        return {
          kind: "verifier",
          name: external.name,
          parameters,
          proposition: propositionName(external.proves as TypeNode),
        };
    }
  }

  private lowerTask(task: TaskDecl): AirTask {
    const environment = new Map<string, Binding>();
    for (const parameter of this.lowerParameters(task)) {
      environment.set(parameter.name, { type: parameter.type });
    }

    const obligations = new Map<string, ObligationState>();
    const airObligations: AirObligation[] = [];
    for (const obligation of task.obligations) {
      if (obligations.has(obligation.id) || environment.has(obligation.id)) {
        checkError("AX1201", `Duplicate obligation \`${obligation.id}\``, obligation);
      }
      const proposition = propositionName(obligation.proposition);
      if (!this.propositions.has(proposition)) {
        checkError("AX1202", `Unknown proposition \`${proposition}\``, obligation);
      }
      obligations.set(obligation.id, { proposition, status: "pending" });
      airObligations.push({ id: obligation.id, proposition, scope: "task" });
    }

    const usedEvidence = new Set<string>();
    const operations: AirOp[] = [];
    let terminated = false;
    for (const [index, statement] of task.body.entries()) {
      if (terminated) {
        checkError("AX1203", "Statements after `complete` or `fail` are unreachable", statement);
      }
      const lowered = this.lowerStatement(
        statement,
        index,
        environment,
        obligations,
        usedEvidence,
      );
      operations.push(lowered);
      terminated = lowered.op === "complete" || lowered.op === "fail";
    }
    if (!terminated) {
      checkError("AX1204", `Task \`${task.name}\` must end in \`complete\` or \`fail\``, task);
    }

    return {
      name: task.name,
      parameters: this.lowerParameters(task),
      returns: this.lowerType(task.returnType),
      obligations: airObligations,
      operations,
    };
  }

  private lowerStatement(
    statement: Stmt,
    site: number,
    environment: Map<string, Binding>,
    obligations: Map<string, ObligationState>,
    usedEvidence: Set<string>,
  ): AirOp {
    switch (statement.kind) {
      case "ObserveStmt": {
        const { name, call } = callParts(statement.expression, statement);
        const port = this.requireExtern(name, "tool", statement);
        if (port.mode !== "read") {
          checkError("AX1301", `observe may call only read tools; \`${name}\` is ${port.mode}`, statement);
        }
        const args = this.lowerCallArguments(call, port, environment);
        this.bind(statement.binding, this.lowerType(port.returnType as TypeNode), statement, environment);
        return { op: "observe", site, destination: statement.binding, port: name, arguments: args };
      }
      case "InferStmt": {
        const { name, call } = callParts(statement.expression, statement);
        const port = this.requireExtern(name, "model", statement);
        const args = this.lowerCallArguments(call, port, environment);
        const inputBytes = statement.limits.inputBytes;
        const outputBytes = statement.limits.outputBytes;
        const attempts = statement.limits.attempts;
        if (
          inputBytes === undefined ||
          outputBytes === undefined ||
          attempts === undefined ||
          !Number.isSafeInteger(inputBytes) ||
          !Number.isSafeInteger(outputBytes) ||
          !Number.isSafeInteger(attempts) ||
          inputBytes <= 0 ||
          outputBytes <= 0 ||
          attempts <= 0
        ) {
          checkError("AX1302", "infer requires positive input_bytes, output_bytes, and attempts limits", statement);
        }
        const resultType: AirType = {
          kind: "candidate",
          value: this.lowerType(port.returnType as TypeNode),
        };
        this.bind(statement.binding, resultType, statement, environment);
        return {
          op: "infer",
          site,
          destination: statement.binding,
          port: name,
          arguments: args,
          limits: { inputBytes, outputBytes, attempts },
        };
      }
      case "ValidateStmt": {
        const { name, call } = callParts(statement.expression, statement);
        const port = this.requireExtern(name, "validator", statement);
        const args = this.lowerCallArguments(call, port, environment);
        const type = this.lowerType(port.returnType as TypeNode);
        this.bind(statement.binding, type, statement, environment);
        return { op: "validate", site, destination: statement.binding, port: name, arguments: args };
      }
      case "ActStmt": {
        const { name, call } = callParts(statement.expression, statement);
        const port = this.requireExtern(name, "tool", statement);
        if (port.mode !== "write") {
          checkError("AX1303", `act may call only write tools; \`${name}\` is ${port.mode}`, statement);
        }
        const args = this.lowerCallArguments(call, port, environment);
        const key = this.lowerExpression(statement.key, environment, namedType("Text")).expression;
        for (const obligation of obligations.values()) {
          if (
            obligation.status === "satisfied" &&
            this.propositions.get(obligation.proposition) === "state"
          ) {
            obligation.status = "pending";
          }
        }
        const type = this.lowerType(port.returnType as TypeNode);
        this.bind(statement.binding, type, statement, environment);
        return {
          op: "act",
          site,
          destination: statement.binding,
          port: name,
          arguments: args,
          idempotencyKey: key,
        };
      }
      case "VerifyStmt": {
        const { name, call } = callParts(statement.expression, statement);
        const port = this.requireExtern(name, "verifier", statement);
        const args = this.lowerCallArguments(call, port, environment);
        const proposition = propositionName(port.proves as TypeNode);
        this.bind(statement.binding, { kind: "evidence", proposition }, statement, environment);
        return {
          op: "verify",
          site,
          destination: statement.binding,
          port: name,
          arguments: args,
          proposition,
        };
      }
      case "SatisfyStmt": {
        const obligation = obligations.get(statement.obligation);
        if (obligation === undefined) {
          checkError("AX1304", `Unknown obligation \`${statement.obligation}\``, statement);
        }
        if (obligation.status === "satisfied") {
          checkError("AX1305", `Obligation \`${statement.obligation}\` is already satisfied`, statement);
        }
        if (statement.evidence.kind !== "RefExpr") {
          checkError("AX1306", "satisfy requires a named evidence value", statement);
        }
        const evidenceName = statement.evidence.name;
        if (usedEvidence.has(evidenceName)) {
          checkError("AX1307", `Evidence \`${evidenceName}\` has already been consumed`, statement);
        }
        const evidence = environment.get(evidenceName);
        const expected: AirType = { kind: "evidence", proposition: obligation.proposition };
        if (evidence === undefined || !typeEquals(evidence.type, expected)) {
          checkError(
            "AX1308",
            `Expected ${typeToString(expected)} for obligation \`${statement.obligation}\``,
            statement,
          );
        }
        usedEvidence.add(evidenceName);
        obligation.status = "satisfied";
        return {
          op: "satisfy",
          site,
          obligation: statement.obligation,
          evidence: evidenceName,
        };
      }
      case "AssertStmt": {
        const condition = this.lowerExpression(statement.condition, environment, namedType("Bool")).expression;
        return { op: "assert", site, condition, message: "Axiom assertion failed" };
      }
      case "CompleteStmt": {
        const pending = [...obligations.entries()]
          .filter(([, value]) => value.status !== "satisfied")
          .map(([name]) => name);
        if (pending.length !== 0) {
          checkError(
            "AX1205",
            `complete is reachable with pending obligation${pending.length === 1 ? "" : "s"}: ${pending.join(", ")}`,
            statement,
          );
        }
        const task = this.tasks.get(
          [...this.tasks.values()].find((candidate) => candidate.body.includes(statement))?.name ?? "",
        );
        const expected = task === undefined ? undefined : this.lowerType(task.returnType);
        const value = this.lowerExpression(statement.value, environment, expected).expression;
        return { op: "complete", site, value };
      }
      case "FailStmt":
        return { op: "fail", site, message: literalMessage(statement.reason, statement) };
    }
  }

  private requireExtern(
    name: string,
    kind: ExternDecl["externKind"],
    node: Stmt,
  ): ExternDecl {
    const external = this.externs.get(name);
    if (external === undefined) {
      checkError("AX1310", `Unknown external port \`${name}\``, node);
    }
    if (external.externKind !== kind) {
      checkError("AX1311", `Expected a ${kind} port, but \`${name}\` is ${external.externKind}`, node);
    }
    return external;
  }

  private lowerCallArguments(
    call: CallExpr,
    external: ExternDecl,
    environment: Map<string, Binding>,
  ): AirExpr[] {
    if (call.arguments.length !== external.parameters.length) {
      checkError(
        "AX1312",
        `Port \`${external.name}\` expects ${external.parameters.length} argument(s), got ${call.arguments.length}`,
        call,
      );
    }
    return call.arguments.map((argument, index) => {
      const parameter = external.parameters[index];
      if (parameter === undefined) {
        checkError("AX1313", "Internal parameter indexing error", call);
      }
      return this.lowerExpression(argument, environment, this.lowerType(parameter.type)).expression;
    });
  }

  private bind(
    name: string,
    type: AirType,
    statement: Stmt,
    environment: Map<string, Binding>,
  ): void {
    if (environment.has(name)) {
      checkError("AX1314", `Immutable binding \`${name}\` is already defined`, statement);
    }
    environment.set(name, { type });
  }

  private lowerExpression(
    expression: Expr,
    environment: Map<string, Binding>,
    expected?: AirType,
  ): { readonly type: AirType; readonly expression: AirExpr } {
    let result: { readonly type: AirType; readonly expression: AirExpr };
    switch (expression.kind) {
      case "LiteralExpr": {
        let type: AirType;
        if (expression.value === null) {
          type = namedType("Unit");
        } else if (typeof expression.value === "boolean") {
          type = namedType("Bool");
        } else if (typeof expression.value === "number") {
          if (!Number.isSafeInteger(expression.value)) {
            checkError("AX1401", "Axiom Core numbers must be safe integers", expression);
          }
          type = namedType("Int");
        } else {
          type = namedType("Text");
        }
        result = { type, expression: { kind: "literal", value: expression.value } };
        break;
      }
      case "RefExpr": {
        if (expression.name === "unit") {
          result = { type: namedType("Unit"), expression: { kind: "literal", value: null } };
          break;
        }
        const binding = environment.get(expression.name);
        if (binding === undefined) {
          checkError("AX1402", `Unknown binding \`${expression.name}\``, expression);
        }
        result = { type: binding.type, expression: { kind: "variable", name: expression.name } };
        break;
      }
      case "ArrayExpr": {
        const expectedElement = expected?.kind === "list" ? expected.element : undefined;
        if (expression.elements.length === 0 && expectedElement === undefined) {
          checkError("AX1403", "An empty array requires an expected List type", expression);
        }
        const items = expression.elements.map((item) =>
          this.lowerExpression(item, environment, expectedElement),
        );
        const elementType = expectedElement ?? (items[0] as { readonly type: AirType }).type;
        for (const item of items) {
          if (!typeEquals(item.type, elementType)) {
            checkError("AX1404", "All array elements must have the same type", expression);
          }
        }
        result = {
          type: { kind: "list", element: elementType },
          expression: { kind: "array", items: items.map((item) => item.expression) },
        };
        break;
      }
      case "RecordExpr": {
        const recordName =
          expression.typeName ??
          (expected?.kind === "named" && this.records.has(expected.name) ? expected.name : undefined);
        if (recordName === undefined) {
          checkError("AX1405", "Record values must name their record type", expression);
        }
        const record = this.records.get(recordName);
        if (record === undefined) {
          checkError("AX1406", `Unknown record type \`${recordName}\``, expression);
        }
        const supplied = new Map(expression.fields.map((field) => [field.name, field]));
        if (supplied.size !== expression.fields.length) {
          checkError("AX1407", `Record \`${recordName}\` contains duplicate fields`, expression);
        }
        if (supplied.size !== record.fields.length) {
          checkError("AX1408", `Record \`${recordName}\` must provide every declared field`, expression);
        }
        const fields = record.fields.map((field) => {
          const suppliedField = supplied.get(field.name);
          if (suppliedField === undefined) {
            checkError("AX1409", `Record \`${recordName}\` is missing field \`${field.name}\``, expression);
          }
          return {
            name: field.name,
            value: this.lowerExpression(
              suppliedField.value,
              environment,
              this.lowerType(field.type),
            ).expression,
          };
        });
        for (const field of expression.fields) {
          if (!record.fields.some((declared) => declared.name === field.name)) {
            checkError("AX1410", `Unknown field \`${field.name}\` for record \`${recordName}\``, field);
          }
        }
        result = {
          type: namedType(recordName),
          expression: { kind: "record", record: recordName, fields },
        };
        break;
      }
      case "FieldAccessExpr": {
        const target = this.lowerExpression(expression.target, environment);
        if (target.type.kind !== "named") {
          checkError("AX1411", "Field access requires a record value", expression);
        }
        const record = this.records.get(target.type.name);
        const field = record?.fields.find((candidate) => candidate.name === expression.field);
        if (field === undefined) {
          checkError("AX1412", `Type \`${typeToString(target.type)}\` has no field \`${expression.field}\``, expression);
        }
        result = {
          type: this.lowerType(field.type),
          expression: { kind: "field", target: target.expression, field: expression.field },
        };
        break;
      }
      case "CallExpr": {
        if (expression.callee.kind !== "RefExpr") {
          checkError("AX1413", "Deterministic builtins must be called by name", expression);
        }
        const name = expression.callee.name;
        const args = expression.arguments.map((argument) => this.lowerExpression(argument, environment));
        if (args.some((argument) => containsCandidate(argument.type))) {
          checkError(
            "AX1426",
            "Candidate values are opaque and may only be passed directly to a validator",
            expression,
          );
        }
        let type: AirType;
        switch (name) {
          case "hash":
            if (args.length !== 1) {
              checkError("AX1414", "hash expects one argument", expression);
            }
            type = namedType("Text");
            break;
          case "len":
            if (
              args.length !== 1 ||
              !(
                typeEquals(args[0]!.type, namedType("Text")) ||
                args[0]!.type.kind === "list"
              )
            ) {
              checkError("AX1415", "len expects one Text or List argument", expression);
            }
            type = namedType("Int");
            break;
          case "utf8_bytes":
            if (
              args.length !== 1 ||
              !typeEquals(args[0]!.type, namedType("Text"))
            ) {
              checkError(
                "AX1428",
                "utf8_bytes expects one Text argument",
                expression,
              );
            }
            type = namedType("Int");
            break;
          case "contains":
            if (
              args.length !== 2 ||
              !(
                (typeEquals(args[0]!.type, namedType("Text")) &&
                  typeEquals(args[1]!.type, namedType("Text"))) ||
                (args[0]!.type.kind === "list" &&
                  typeEquals(args[0]!.type.element, args[1]!.type))
              )
            ) {
              checkError(
                "AX1416",
                "contains expects Text/Text or List<T>/T arguments",
                expression,
              );
            }
            type = namedType("Bool");
            break;
          case "sort":
            if (
              args.length !== 1 ||
              args[0]?.type.kind !== "list" ||
              !(
                typeEquals(args[0].type.element, namedType("Int")) ||
                typeEquals(args[0].type.element, namedType("Text"))
              )
            ) {
              checkError("AX1417", "sort expects one List<Int> or List<Text> argument", expression);
            }
            type = args[0].type;
            break;
          case "min":
          case "max":
            if (args.length === 0 || args.some((arg) => !typeEquals(arg.type, namedType("Int")))) {
              checkError("AX1418", `${name} expects one or more Int arguments`, expression);
            }
            type = namedType("Int");
            break;
          default:
            checkError("AX1419", `Calls to \`${name}\` are only legal in their matching effect statement`, expression);
        }
        result = {
          type,
          expression: { kind: "call", callee: name, arguments: args.map((arg) => arg.expression) },
        };
        break;
      }
      case "UnaryExpr": {
        const operand = this.lowerExpression(expression.operand, environment);
        if (expression.operator === "!") {
          if (!typeEquals(operand.type, namedType("Bool"))) {
            checkError("AX1420", "! expects a Bool operand", expression);
          }
          result = {
            type: namedType("Bool"),
            expression: {
              kind: "binary",
              operator: "==",
              left: operand.expression,
              right: { kind: "literal", value: false },
            },
          };
        } else {
          if (!typeEquals(operand.type, namedType("Int"))) {
            checkError("AX1421", `${expression.operator} expects an Int operand`, expression);
          }
          result =
            expression.operator === "+"
              ? operand
              : {
                  type: namedType("Int"),
                  expression: {
                    kind: "binary",
                    operator: "-",
                    left: { kind: "literal", value: 0 },
                    right: operand.expression,
                  },
                };
        }
        break;
      }
      case "BinaryExpr": {
        const left = this.lowerExpression(expression.left, environment);
        const right = this.lowerExpression(expression.right, environment);
        if (containsCandidate(left.type) || containsCandidate(right.type)) {
          checkError(
            "AX1427",
            "Candidate values cannot participate in deterministic expressions",
            expression,
          );
        }
        const equality = expression.operator === "==" || expression.operator === "!=";
        const ordering = ["<", "<=", ">", ">="].includes(expression.operator);
        const boolean = expression.operator === "&&" || expression.operator === "||";
        if (!typeEquals(left.type, right.type)) {
          checkError("AX1422", `Operator \`${expression.operator}\` requires matching operand types`, expression);
        }
        if (boolean && !typeEquals(left.type, namedType("Bool"))) {
          checkError("AX1423", `Operator \`${expression.operator}\` requires Bool operands`, expression);
        }
        if (
          ordering &&
          !typeEquals(left.type, namedType("Int")) &&
          !typeEquals(left.type, namedType("Text"))
        ) {
          checkError(
            "AX1424",
            `Operator \`${expression.operator}\` requires Int or Text operands`,
            expression,
          );
        }
        if (
          !equality &&
          !ordering &&
          !boolean &&
          !typeEquals(left.type, namedType("Int")) &&
          !(expression.operator === "+" && typeEquals(left.type, namedType("Text")))
        ) {
          checkError("AX1424", `Operator \`${expression.operator}\` does not support ${typeToString(left.type)}`, expression);
        }
        result = {
          type: equality || ordering || boolean ? namedType("Bool") : left.type,
          expression: {
            kind: "binary",
            operator: expression.operator,
            left: left.expression,
            right: right.expression,
          },
        };
        break;
      }
    }

    if (expected !== undefined && !typeEquals(result.type, expected)) {
      checkError(
        "AX1425",
        `Expected ${typeToString(expected)}, got ${typeToString(result.type)}`,
        expression,
      );
    }
    return result;
  }
}

/**
 * Canonical digest used by a source-wide `review` seal.
 *
 * Only resolutions for the named source participate. Sorting uses code-unit
 * order rather than locale-sensitive collation. The caller must resolve each
 * requirement link to its proposition signature; returning undefined records
 * a null target and will not match a valid compiler seal.
 */
export function reviewDispositionsHash(
  source: string,
  resolutions: readonly ResolvedDecl[],
  resolveTarget: (
    task: string,
    obligation: string,
  ) => ReviewTargetSignature | undefined,
): Sha256 {
  const selected = resolutions
    .filter((resolution) => resolution.source === source)
    .slice()
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .map((resolution) => ({
      id: resolution.name,
      source: resolution.source,
      byte_start: resolution.byteStart,
      byte_end: resolution.byteEnd,
      sha256: resolution.hash,
      disposition: resolution.disposition,
      ...(resolution.disposition === "requirement"
        ? {
            task: resolution.task,
            obligation: resolution.obligation,
            target: resolveTarget(
              resolution.task,
              resolution.obligation,
            ) ?? null,
          }
        : {}),
      reason: resolution.reason,
    }));
  return canonicalHash({
    format: "AXREVIEW-DISPOSITIONS/0.2",
    source,
    resolutions: selected,
  });
}

export type ReviewTargetSignature = {
  readonly proposition: string;
  readonly mode: PropositionMode;
  /**
   * Hash of all executable formal declarations. This deliberately invalidates
   * a prose review if task, verifier, validator, port, record, or proposition
   * semantics change while their names remain stable.
   */
  readonly formalHash: Sha256;
};

export type ReviewFormalSemantics = Pick<
  AirProgram,
  "language" | "records" | "propositions" | "ports" | "tasks"
>;

export function reviewFormalSemanticsHash(
  semantics: ReviewFormalSemantics,
): Sha256 {
  return canonicalHash({
    format: "AXREVIEW-FORMAL/0.1",
    language: semantics.language,
    records: semantics.records,
    propositions: semantics.propositions,
    ports: semantics.ports,
    tasks: semantics.tasks,
  });
}

export function compileAst(ast: Program, source: string): CompiledProgram {
  return new Compiler(source, ast).compile();
}

export function compileSource(source: string, sourceName = "<source>"): CompiledProgram {
  return compileAst(parse(source, sourceName), source);
}
