import { ParseError, type SourceLocation } from "./errors.ts";
import { tokenize, type Token } from "./lexer.ts";
import type {
  ActStmt,
  ArrayExpr,
  AssertStmt,
  BinaryExpr,
  BinaryOperator,
  CompleteStmt,
  Decl,
  ExternDecl,
  ExternKind,
  Expr,
  FailStmt,
  FieldDecl,
  InferLimits,
  InferStmt,
  LiteralExpr,
  NamedTypeNode,
  ObligationDecl,
  ObserveStmt,
  Parameter,
  Program,
  PropositionDecl,
  RecordDecl,
  RecordExpr,
  RecordField,
  ResolvedDecl,
  ReviewDecl,
  SatisfyStmt,
  SourceDecl,
  SourceSpan,
  Stmt,
  TaskDecl,
  ToolMode,
  TypeNode,
  UnaryExpr,
  UnaryOperator,
  UnresolvedDecl,
  ValidateStmt,
  VerifyStmt,
} from "./ast.ts";

const EXTERN_KINDS = new Set<ExternKind>([
  "tool",
  "model",
  "validator",
  "verifier",
]);

const BINARY_PRECEDENCE: Readonly<Record<BinaryOperator, number>> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const BINARY_OPERATORS = new Set<BinaryOperator>(
  Object.keys(BINARY_PRECEDENCE) as BinaryOperator[],
);

export class Parser {
  readonly sourceName: string;
  readonly tokens: readonly Token[];

  private index = 0;

  constructor(source: string, sourceName = "<source>") {
    this.sourceName = sourceName;
    this.tokens = tokenize(source, sourceName);
  }

  parseProgram(): Program {
    const start = this.expectWord("axiom").span.start;
    const versionToken = this.expectKind(
      "number",
      "Expected the Axiom language version after `axiom`.",
    );
    if (versionToken.raw !== "0.1") {
      this.error(
        versionToken,
        "A200",
        `Unsupported Axiom version ${JSON.stringify(versionToken.raw)}; expected 0.1.`,
      );
    }
    this.expect(";");

    const declarations: Decl[] = [];
    while (!this.atEnd()) {
      declarations.push(this.parseDeclaration());
    }

    return {
      kind: "Program",
      version: versionToken.raw,
      declarations,
      span: this.span(start, this.current().span.end),
    };
  }

  private parseDeclaration(): Decl {
    if (this.checkWord("source")) {
      return this.parseSourceDeclaration();
    }
    if (this.checkWord("unresolved")) {
      return this.parseUnresolvedDeclaration();
    }
    if (this.checkWord("resolved")) {
      return this.parseResolvedDeclaration();
    }
    if (this.checkWord("review")) {
      return this.parseReviewDeclaration();
    }
    if (this.checkWord("record")) {
      return this.parseRecordDeclaration();
    }
    if (this.checkWord("proposition")) {
      return this.parsePropositionDeclaration();
    }
    if (this.checkWord("extern")) {
      return this.parseExternDeclaration();
    }
    if (this.checkWord("task")) {
      return this.parseTaskDeclaration();
    }

    this.error(
      this.current(),
      "A201",
      "Expected a source, unresolved, resolved, review, record, proposition, extern, or task declaration.",
    );
  }

  private parseSourceDeclaration(): SourceDecl {
    const start = this.expectWord("source").span.start;
    const name = this.expectIdentifier("Expected a source identifier.").value;
    this.expectWord("path");
    const path = this.expectKind(
      "string",
      "Expected a source path string.",
    ).value;
    this.expectWord("hash");
    const hash = this.expectKind(
      "string",
      "Expected a source SHA-256 string.",
    ).value;
    this.expectWord("bytes");
    const byteLength = this.parseNonnegativeInteger(
      "Expected a non-negative source byte length.",
    );
    this.expectWord("base64");
    const base64 = this.expectKind(
      "string",
      "Expected the exact source bytes as base64.",
    ).value;
    this.expectWord("map");
    const mapPath = this.expectKind(
      "string",
      "Expected a coverage map path string.",
    ).value;
    const end = this.expect(";").span.end;
    return {
      kind: "SourceDecl",
      name,
      path,
      hash,
      byteLength,
      base64,
      mapPath,
      span: this.span(start, end),
    };
  }

  private parseUnresolvedDeclaration(): UnresolvedDecl {
    const start = this.expectWord("unresolved").span.start;
    const name = this.expectIdentifier(
      "Expected an unresolved-clause identifier.",
    ).value;
    this.expectWord("source");
    const source = this.expectIdentifier(
      "Expected a source identifier after `source`.",
    ).value;
    this.expectWord("bytes");
    const byteStart = this.parseNonnegativeInteger(
      "Expected a non-negative source-span start.",
    );
    const byteEnd = this.parseNonnegativeInteger(
      "Expected a non-negative source-span end.",
    );
    this.expectWord("hash");
    const hash = this.expectKind(
      "string",
      "Expected a source-span SHA-256 string.",
    ).value;
    this.expectWord("category");
    const category = this.expectKind(
      "string",
      "Expected an unresolved-clause category string.",
    ).value;
    this.expectWord("reason");
    const reason = this.expectKind(
      "string",
      "Expected an unresolved-clause reason string.",
    ).value;
    const end = this.expect(";").span.end;
    return {
      kind: "UnresolvedDecl",
      name,
      source,
      byteStart,
      byteEnd,
      hash,
      category,
      reason,
      span: this.span(start, end),
    };
  }

  private parseResolvedDeclaration(): ResolvedDecl {
    const start = this.expectWord("resolved").span.start;
    const name = this.expectIdentifier(
      "Expected a compiler-derived span identifier after `resolved`.",
    ).value;
    this.expectWord("source");
    const source = this.expectIdentifier(
      "Expected a source identifier after `source`.",
    ).value;
    this.expectWord("bytes");
    const byteStart = this.parseNonnegativeInteger(
      "Expected a non-negative reviewed source-span start.",
    );
    const byteEnd = this.parseNonnegativeInteger(
      "Expected a non-negative reviewed source-span end.",
    );
    this.expectWord("hash");
    const hash = this.expectKind(
      "string",
      "Expected the reviewed source-span SHA-256 string.",
    ).value;
    this.expectWord("as");
    const dispositionToken = this.expectIdentifier(
      "Expected resolution kind `requirement` or `non_normative` after `as`.",
    );

    if (dispositionToken.value === "requirement") {
      this.expectWord("task");
      const task = this.expectIdentifier(
        "Expected a task name for the requirement resolution.",
      ).value;
      this.expectWord("obligation");
      const obligation = this.expectIdentifier(
        "Expected an obligation identifier for the requirement resolution.",
      ).value;
      this.expectWord("reason");
      const reason = this.expectKind(
        "string",
        "Expected a review reason string.",
      ).value;
      const end = this.expect(";").span.end;
      return {
        kind: "ResolvedDecl",
        name,
        source,
        byteStart,
        byteEnd,
        hash,
        disposition: "requirement",
        task,
        obligation,
        reason,
        span: this.span(start, end),
      };
    }

    if (dispositionToken.value === "non_normative") {
      this.expectWord("reason");
      const reason = this.expectKind(
        "string",
        "Expected a non-normative review reason string.",
      ).value;
      const end = this.expect(";").span.end;
      return {
        kind: "ResolvedDecl",
        name,
        source,
        byteStart,
        byteEnd,
        hash,
        disposition: "non_normative",
        reason,
        span: this.span(start, end),
      };
    }

    this.error(
      dispositionToken,
      "A241",
      `Unknown resolution kind ${JSON.stringify(dispositionToken.value)}; ` +
        "expected `requirement` or `non_normative`.",
    );
  }

  private parseReviewDeclaration(): ReviewDecl {
    const start = this.expectWord("review").span.start;
    const source = this.expectIdentifier(
      "Expected an imported source identifier after `review`.",
    ).value;
    this.expectWord("source_hash");
    const sourceHash = this.expectKind(
      "string",
      "Expected the reviewed source SHA-256 string.",
    ).value;
    this.expectWord("dispositions_hash");
    const dispositionsHash = this.expectKind(
      "string",
      "Expected the canonical dispositions SHA-256 string.",
    ).value;
    const end = this.expect(";").span.end;
    return {
      kind: "ReviewDecl",
      source,
      sourceHash,
      dispositionsHash,
      span: this.span(start, end),
    };
  }

  private parseRecordDeclaration(): RecordDecl {
    const start = this.expectWord("record").span.start;
    const name = this.expectIdentifier("Expected a record name.").value;
    const fields = this.parseFieldBlock();
    const end = this.previous().span.end;
    this.match(";");
    return {
      kind: "RecordDecl",
      name,
      fields,
      span: this.span(start, end),
    };
  }

  private parsePropositionDeclaration(): PropositionDecl {
    const start = this.expectWord("proposition").span.start;
    const name = this.expectIdentifier("Expected a proposition name.").value;
    let parameters: readonly Parameter[] = [];

    // Parameterized propositions are a forward-compatible surface feature;
    // Core 0.1 normally declares nominal propositions.
    if (this.check("(")) {
      parameters = this.parseParameterList();
    } else if (this.check("{")) {
      parameters = this.fieldsToParameters(this.parseFieldBlock());
    }

    const modeToken = this.expectIdentifier(
      "Expected proposition mode `event` or `state`.",
    );
    if (modeToken.value !== "event" && modeToken.value !== "state") {
      this.error(
        modeToken,
        "A202",
        "Proposition mode must be `event` or `state`.",
      );
    }
    const end = this.expect(";").span.end;

    return {
      kind: "PropositionDecl",
      name,
      mode: modeToken.value,
      parameters,
      span: this.span(start, end),
    };
  }

  private parseExternDeclaration(): ExternDecl {
    const start = this.expectWord("extern").span.start;
    const kindToken = this.expectIdentifier(
      "Expected extern kind `tool`, `model`, `validator`, or `verifier`.",
    );
    if (!EXTERN_KINDS.has(kindToken.value as ExternKind)) {
      this.error(
        kindToken,
        "A203",
        "Extern kind must be `tool`, `model`, `validator`, or `verifier`.",
      );
    }
    const externKind = kindToken.value as ExternKind;
    const name = this.expectIdentifier("Expected an extern name.").value;
    const parameters = this.parseParameterList();

    let returnType: TypeNode | undefined;
    let mode: ToolMode | undefined;
    let intent: string | undefined;
    let proves: TypeNode | undefined;

    if (this.match("->")) {
      returnType = this.parseType();
    }

    while (!this.check(";") && !this.atEnd()) {
      if (this.matchWord("mode")) {
        if (mode !== undefined) {
          this.error(this.previous(), "A204", "Duplicate extern mode.");
        }
        const modeToken = this.expectIdentifier("Expected a tool mode.");
        if (modeToken.value !== "read" && modeToken.value !== "write") {
          this.error(
            modeToken,
            "A209",
            "A tool mode must be `read` or `write`.",
          );
        }
        mode = modeToken.value;
        continue;
      }
      if (this.matchWord("intent")) {
        if (intent !== undefined) {
          this.error(this.previous(), "A205", "Duplicate model intent.");
        }
        intent = this.expectKind(
          "string",
          "Expected a string after `intent`.",
        ).value;
        continue;
      }
      if (this.matchWord("proves")) {
        if (proves !== undefined) {
          this.error(this.previous(), "A206", "Duplicate `proves` clause.");
        }
        proves = this.parseType();
        continue;
      }
      this.error(
        this.current(),
        "A207",
        "Expected extern metadata (`mode`, `intent`, or `proves`) or `;`.",
      );
    }
    const end = this.expect(";").span.end;

    if (externKind === "tool" && mode === undefined) {
      this.error(
        kindToken,
        "A208",
        "An extern tool must declare `mode read` or `mode write`.",
      );
    }
    if (externKind === "model" && intent === undefined) {
      this.error(
        kindToken,
        "A210",
        "An extern model must declare a literal `intent`.",
      );
    }
    if (externKind === "verifier" && proves === undefined) {
      this.error(
        kindToken,
        "A211",
        "An extern verifier must declare which proposition it `proves`.",
      );
    }
    if (externKind !== "verifier" && returnType === undefined) {
      this.error(
        kindToken,
        "A212",
        `An extern ${externKind} must declare a return type.`,
      );
    }
    if (externKind === "verifier" && returnType !== undefined) {
      this.error(
        kindToken,
        "A235",
        "An extern verifier uses `proves` and cannot declare a return type.",
      );
    }
    if (externKind !== "tool" && mode !== undefined) {
      this.error(
        kindToken,
        "A236",
        "Only an extern tool may declare `mode`.",
      );
    }
    if (externKind !== "model" && intent !== undefined) {
      this.error(
        kindToken,
        "A237",
        "Only an extern model may declare `intent`.",
      );
    }
    if (externKind !== "verifier" && proves !== undefined) {
      this.error(
        kindToken,
        "A238",
        "Only an extern verifier may declare `proves`.",
      );
    }

    return {
      kind: "ExternDecl",
      externKind,
      name,
      parameters,
      ...(returnType === undefined ? {} : { returnType }),
      ...(mode === undefined ? {} : { mode }),
      ...(intent === undefined ? {} : { intent }),
      ...(proves === undefined ? {} : { proves }),
      span: this.span(start, end),
    };
  }

  private parseTaskDeclaration(): TaskDecl {
    const start = this.expectWord("task").span.start;
    const name = this.expectIdentifier("Expected a task name.").value;
    const parameters = this.parseParameterList();
    this.expect("->");
    const returnType = this.parseType();
    this.expectWord("must");
    const obligations = this.parseObligationBlock();
    const body = this.parseStatementBlock();

    return {
      kind: "TaskDecl",
      name,
      parameters,
      returnType,
      obligations,
      body,
      span: this.span(start, this.previous().span.end),
    };
  }

  private parseObligationBlock(): readonly ObligationDecl[] {
    this.expect("{");
    const obligations: ObligationDecl[] = [];
    const ids = new Set<string>();

    while (!this.check("}") && !this.atEnd()) {
      const startToken = this.expectIdentifier(
        "Expected an obligation identifier.",
      );
      if (ids.has(startToken.value)) {
        this.error(
          startToken,
          "A213",
          `Duplicate obligation ${JSON.stringify(startToken.value)}.`,
        );
      }
      ids.add(startToken.value);
      this.expect(":");
      const proposition = this.parseType();
      const end = this.expect(";").span.end;
      obligations.push({
        kind: "ObligationDecl",
        id: startToken.value,
        proposition,
        span: this.span(startToken.span.start, end),
      });
    }

    this.expect("}");
    return obligations;
  }

  private parseStatementBlock(): readonly Stmt[] {
    this.expect("{");
    const statements: Stmt[] = [];
    while (!this.check("}") && !this.atEnd()) {
      statements.push(this.parseStatement());
    }
    this.expect("}");
    return statements;
  }

  private parseStatement(): Stmt {
    if (this.checkWord("observe")) {
      return this.parseObserveStatement();
    }
    if (this.checkWord("infer")) {
      return this.parseInferStatement();
    }
    if (this.checkWord("validate")) {
      return this.parseValidateStatement();
    }
    if (this.checkWord("act")) {
      return this.parseActStatement();
    }
    if (this.checkWord("verify")) {
      return this.parseVerifyStatement();
    }
    if (this.checkWord("satisfy")) {
      return this.parseSatisfyStatement();
    }
    if (this.checkWord("assert")) {
      return this.parseAssertStatement();
    }
    if (this.checkWord("complete")) {
      return this.parseCompleteStatement();
    }
    if (this.checkWord("fail")) {
      return this.parseFailStatement();
    }

    this.error(
      this.current(),
      "A214",
      "Expected observe, infer, validate, act, verify, satisfy, assert, complete, or fail.",
    );
  }

  private parseObserveStatement(): ObserveStmt {
    const start = this.expectWord("observe").span.start;
    const binding = this.parseBinding();
    const expression = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "ObserveStmt",
      binding,
      expression,
      span: this.span(start, end),
    };
  }

  private parseInferStatement(): InferStmt {
    const start = this.expectWord("infer").span.start;
    const binding = this.parseBinding();
    const expression = this.parseExpression();
    this.expectWord("limit");

    let inputBytes: number | undefined;
    let outputBytes: number | undefined;
    let attempts: number | undefined;

    while (!this.check(";") && !this.atEnd()) {
      const limitName = this.expectIdentifier(
        "Expected `input_bytes`, `output_bytes`, or `attempts`.",
      );
      const value = this.parsePositiveInteger();
      switch (limitName.value) {
        case "input_bytes":
          if (inputBytes !== undefined) {
            this.error(limitName, "A215", "Duplicate `input_bytes` limit.");
          }
          inputBytes = value;
          break;
        case "output_bytes":
          if (outputBytes !== undefined) {
            this.error(limitName, "A216", "Duplicate `output_bytes` limit.");
          }
          outputBytes = value;
          break;
        case "attempts":
          if (attempts !== undefined) {
            this.error(limitName, "A217", "Duplicate `attempts` limit.");
          }
          attempts = value;
          break;
        default:
          this.error(
            limitName,
            "A219",
            "Unknown inference limit; expected `input_bytes`, `output_bytes`, or `attempts`.",
          );
      }
    }
    const end = this.expect(";").span.end;

    if (
      inputBytes === undefined ||
      outputBytes === undefined ||
      attempts === undefined
    ) {
      this.error(
        this.previous(),
        "A220",
        "Inference limits must specify input_bytes, output_bytes, and attempts.",
      );
    }
    const limits: InferLimits = { inputBytes, outputBytes, attempts };

    return {
      kind: "InferStmt",
      binding,
      expression,
      limits,
      span: this.span(start, end),
    };
  }

  private parseValidateStatement(): ValidateStmt {
    const start = this.expectWord("validate").span.start;
    const binding = this.parseBinding();
    const expression = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "ValidateStmt",
      binding,
      expression,
      span: this.span(start, end),
    };
  }

  private parseActStatement(): ActStmt {
    const start = this.expectWord("act").span.start;
    const binding = this.parseBinding();
    const expression = this.parseExpression();
    this.expectWord("key");
    const key = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "ActStmt",
      binding,
      expression,
      key,
      span: this.span(start, end),
    };
  }

  private parseVerifyStatement(): VerifyStmt {
    const start = this.expectWord("verify").span.start;
    const binding = this.parseBinding();
    const expression = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "VerifyStmt",
      binding,
      expression,
      span: this.span(start, end),
    };
  }

  private parseSatisfyStatement(): SatisfyStmt {
    const start = this.expectWord("satisfy").span.start;
    const obligation = this.expectIdentifier(
      "Expected an obligation identifier after `satisfy`.",
    ).value;
    this.expectWord("with");
    const evidence = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "SatisfyStmt",
      obligation,
      evidence,
      span: this.span(start, end),
    };
  }

  private parseAssertStatement(): AssertStmt {
    const start = this.expectWord("assert").span.start;
    const condition = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "AssertStmt",
      condition,
      span: this.span(start, end),
    };
  }

  private parseCompleteStatement(): CompleteStmt {
    const start = this.expectWord("complete").span.start;
    const value = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "CompleteStmt",
      value,
      span: this.span(start, end),
    };
  }

  private parseFailStatement(): FailStmt {
    const start = this.expectWord("fail").span.start;
    const reason = this.parseExpression();
    const end = this.expect(";").span.end;
    return {
      kind: "FailStmt",
      reason,
      span: this.span(start, end),
    };
  }

  private parseBinding(): string {
    const binding = this.expectIdentifier("Expected a binding name.").value;
    this.expect("=");
    return binding;
  }

  private parseExpression(minimumPrecedence = 0): Expr {
    let left = this.parseUnaryExpression();

    while (true) {
      const value = this.current().value as BinaryOperator;
      if (!BINARY_OPERATORS.has(value)) {
        break;
      }
      const precedence = BINARY_PRECEDENCE[value];
      if (precedence < minimumPrecedence) {
        break;
      }
      this.advance();
      const right = this.parseExpression(precedence + 1);
      const expression: BinaryExpr = {
        kind: "BinaryExpr",
        operator: value,
        left,
        right,
        span: this.span(left.span.start, right.span.end),
      };
      left = expression;
    }

    return left;
  }

  private parseUnaryExpression(): Expr {
    const token = this.current();
    if (token.value === "!" || token.value === "-" || token.value === "+") {
      this.advance();
      const operand = this.parseUnaryExpression();
      const expression: UnaryExpr = {
        kind: "UnaryExpr",
        operator: token.value as UnaryOperator,
        operand,
        span: this.span(token.span.start, operand.span.end),
      };
      return expression;
    }
    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): Expr {
    let expression = this.parsePrimaryExpression();

    while (true) {
      if (this.match("(")) {
        const arguments_: Expr[] = [];
        if (!this.check(")")) {
          while (true) {
            arguments_.push(this.parseExpression());
            if (!this.match(",") || this.check(")")) {
              break;
            }
          }
        }
        const end = this.expect(")").span.end;
        expression = {
          kind: "CallExpr",
          callee: expression,
          arguments: arguments_,
          span: this.span(expression.span.start, end),
        };
        continue;
      }

      if (this.match(".")) {
        const field = this.expectIdentifier(
          "Expected a field name after `.`.",
        );
        expression = {
          kind: "FieldAccessExpr",
          target: expression,
          field: field.value,
          span: this.span(expression.span.start, field.span.end),
        };
        continue;
      }

      if (this.check("{")) {
        const typeName = this.expressionAsQualifiedName(expression);
        if (typeName === undefined) {
          break;
        }
        expression = this.parseRecordExpression(
          expression.span.start,
          typeName,
        );
        continue;
      }

      break;
    }

    return expression;
  }

  private parsePrimaryExpression(): Expr {
    const token = this.current();

    if (token.kind === "string") {
      this.advance();
      return this.literal(token, token.value);
    }
    if (token.kind === "number") {
      this.advance();
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token.raw)) {
        this.error(
          token,
          "A221",
          "Axiom numeric literals must use non-negative integer syntax; use unary `-` for negative integers.",
        );
      }
      const value = Number(token.value);
      if (!Number.isSafeInteger(value)) {
        this.error(token, "A221", "Numeric literal exceeds the safe integer range.");
      }
      return this.literal(token, value);
    }
    if (token.kind === "identifier") {
      if (token.value === "true" || token.value === "false") {
        this.advance();
        return this.literal(token, token.value === "true");
      }
      if (token.value === "null") {
        this.advance();
        return this.literal(token, null);
      }
      this.advance();
      return {
        kind: "RefExpr",
        name: token.value,
        span: token.span,
      };
    }
    if (this.match("[")) {
      return this.parseArrayExpression(this.previous());
    }
    if (this.check("{")) {
      return this.parseRecordExpression(token.span.start);
    }
    if (this.match("(")) {
      const expression = this.parseExpression();
      this.expect(")");
      return expression;
    }

    this.error(token, "A222", "Expected an expression.");
  }

  private parseArrayExpression(open: Token): ArrayExpr {
    const elements: Expr[] = [];
    if (!this.check("]")) {
      while (true) {
        elements.push(this.parseExpression());
        if (!this.match(",") || this.check("]")) {
          break;
        }
      }
    }
    const end = this.expect("]").span.end;
    return {
      kind: "ArrayExpr",
      elements,
      span: this.span(open.span.start, end),
    };
  }

  private parseRecordExpression(
    start: SourceLocation,
    typeName?: string,
  ): RecordExpr {
    this.expect("{");
    const fields: RecordField[] = [];
    while (!this.check("}") && !this.atEnd()) {
      const fieldToken = this.current();
      if (fieldToken.kind !== "identifier" && fieldToken.kind !== "string") {
        this.error(fieldToken, "A223", "Expected a record field name.");
      }
      this.advance();

      let value: Expr;
      if (this.match(":")) {
        value = this.parseExpression();
      } else if (fieldToken.kind === "identifier") {
        value = {
          kind: "RefExpr",
          name: fieldToken.value,
          span: fieldToken.span,
        };
      } else {
        this.error(
          fieldToken,
          "A224",
          "A string-named record field must have an explicit value.",
        );
      }

      fields.push({
        kind: "RecordField",
        name: fieldToken.value,
        value,
        span: this.span(fieldToken.span.start, value.span.end),
      });

      if (!this.match(",") && !this.match(";") && !this.check("}")) {
        this.error(
          this.current(),
          "A225",
          "Expected `,`, `;`, or `}` after a record field.",
        );
      }
    }
    const end = this.expect("}").span.end;

    return {
      kind: "RecordExpr",
      ...(typeName === undefined ? {} : { typeName }),
      fields,
      span: this.span(start, end),
    };
  }

  private literal(
    token: Token,
    value: null | boolean | number | string,
  ): LiteralExpr {
    return {
      kind: "LiteralExpr",
      value,
      raw: token.raw,
      span: token.span,
    };
  }

  private expressionAsQualifiedName(expression: Expr): string | undefined {
    if (expression.kind === "RefExpr") {
      return expression.name;
    }
    if (expression.kind === "FieldAccessExpr") {
      const prefix = this.expressionAsQualifiedName(expression.target);
      return prefix === undefined ? undefined : `${prefix}.${expression.field}`;
    }
    return undefined;
  }

  private parseFieldBlock(): readonly FieldDecl[] {
    this.expect("{");
    const fields: FieldDecl[] = [];
    const names = new Set<string>();

    while (!this.check("}") && !this.atEnd()) {
      const nameToken = this.expectIdentifier("Expected a field name.");
      if (names.has(nameToken.value)) {
        this.error(
          nameToken,
          "A226",
          `Duplicate field ${JSON.stringify(nameToken.value)}.`,
        );
      }
      names.add(nameToken.value);
      const optional = this.match("?");
      this.expect(":");
      const type = this.parseType();
      const separator = this.current();
      if (!this.match(";") && !this.match(",")) {
        this.error(separator, "A227", "Expected `;` after a field.");
      }
      fields.push({
        kind: "FieldDecl",
        name: nameToken.value,
        type,
        optional,
        span: this.span(nameToken.span.start, this.previous().span.end),
      });
    }
    this.expect("}");
    return fields;
  }

  private parseParameterList(): readonly Parameter[] {
    this.expect("(");
    const parameters: Parameter[] = [];
    const names = new Set<string>();
    if (!this.check(")")) {
      while (true) {
        const nameToken = this.expectIdentifier("Expected a parameter name.");
        if (names.has(nameToken.value)) {
          this.error(
            nameToken,
            "A228",
            `Duplicate parameter ${JSON.stringify(nameToken.value)}.`,
          );
        }
        names.add(nameToken.value);
        this.expect(":");
        const type = this.parseType();
        parameters.push({
          kind: "Parameter",
          name: nameToken.value,
          type,
          span: this.span(nameToken.span.start, type.span.end),
        });
        if (!this.match(",") || this.check(")")) {
          break;
        }
      }
    }
    this.expect(")");
    return parameters;
  }

  private parseType(): TypeNode {
    const startToken = this.expectIdentifier("Expected a type name.");
    let name = startToken.value;
    while (this.match(".")) {
      name += `.${this.expectIdentifier(
        "Expected a type-name segment after `.`.",
      ).value}`;
    }

    const arguments_: TypeNode[] = [];
    if (this.match("<")) {
      if (this.check(">")) {
        this.error(
          this.current(),
          "A229",
          "A generic type must contain at least one type argument.",
        );
      }
      while (true) {
        arguments_.push(this.parseType());
        if (!this.match(",") || this.check(">")) {
          break;
        }
      }
      this.expect(">");
    }

    let type: TypeNode = {
      kind: "NamedType",
      name,
      arguments: arguments_,
      span: this.span(startToken.span.start, this.previous().span.end),
    } satisfies NamedTypeNode;

    while (true) {
      if (this.match("[")) {
        const end = this.expect("]").span.end;
        type = {
          kind: "ArrayType",
          element: type,
          span: this.span(type.span.start, end),
        };
        continue;
      }
      if (this.match("?")) {
        type = {
          kind: "OptionalType",
          inner: type,
          span: this.span(type.span.start, this.previous().span.end),
        };
        continue;
      }
      break;
    }
    return type;
  }

  private fieldsToParameters(
    fields: readonly FieldDecl[],
  ): readonly Parameter[] {
    return fields.map((field) => ({
      kind: "Parameter",
      name: field.name,
      type: field.type,
      span: field.span,
    }));
  }

  private parsePositiveInteger(): number {
    const token = this.expectKind(
      "number",
      "Expected a positive integer limit.",
    );
    if (!/^[1-9][0-9]*$/u.test(token.raw)) {
      this.error(token, "A230", "Expected a positive integer limit.");
    }
    const value = Number(token.raw);
    if (!Number.isSafeInteger(value)) {
      this.error(token, "A231", "Integer limit exceeds the safe range.");
    }
    return value;
  }

  private parseNonnegativeInteger(message: string): number {
    const token = this.expectKind("number", message);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token.raw)) {
      this.error(token, "A239", message);
    }
    const value = Number(token.raw);
    if (!Number.isSafeInteger(value)) {
      this.error(token, "A240", "Integer exceeds the safe range.");
    }
    return value;
  }

  private current(): Token {
    // tokenize() always appends EOF.
    return this.tokens[this.index] as Token;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] as Token;
  }

  private atEnd(): boolean {
    return this.current().kind === "eof";
  }

  private check(value: string): boolean {
    return this.current().value === value;
  }

  private checkWord(value: string): boolean {
    return (
      this.current().kind === "identifier" && this.current().value === value
    );
  }

  private match(value: string): boolean {
    if (!this.check(value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private matchWord(value: string): boolean {
    if (!this.checkWord(value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private expect(value: string): Token {
    if (!this.check(value)) {
      this.error(
        this.current(),
        "A232",
        `Expected ${JSON.stringify(value)}, found ${this.describe(this.current())}.`,
      );
    }
    return this.advance();
  }

  private expectWord(value: string): Token {
    if (!this.checkWord(value)) {
      this.error(
        this.current(),
        "A233",
        `Expected keyword ${JSON.stringify(value)}, found ${this.describe(this.current())}.`,
      );
    }
    return this.advance();
  }

  private expectIdentifier(message: string): Token {
    return this.expectKind("identifier", message);
  }

  private expectKind(kind: Token["kind"], message: string): Token {
    const token = this.current();
    if (token.kind !== kind) {
      this.error(token, "A234", message);
    }
    return this.advance();
  }

  private advance(): Token {
    const token = this.current();
    if (!this.atEnd()) {
      this.index += 1;
    }
    return token;
  }

  private describe(token: Token): string {
    if (token.kind === "eof") {
      return "end of input";
    }
    return JSON.stringify(token.raw);
  }

  private span(start: SourceLocation, end: SourceLocation): SourceSpan {
    return { sourceName: this.sourceName, start, end };
  }

  private error(token: Token, code: string, message: string): never {
    throw new ParseError(code, message, token.span.start);
  }
}

export function parse(source: string, sourceName = "<source>"): Program {
  return new Parser(source, sourceName).parseProgram();
}
