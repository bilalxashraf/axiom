import type { SourceLocation } from "./errors.ts";

/**
 * Source spans are half-open: `start` points at the first character in a node
 * and `end` points immediately after its last character.
 */
export type SourceSpan = {
  readonly sourceName: string;
  readonly start: SourceLocation;
  readonly end: SourceLocation;
};

export type Node = {
  readonly kind: string;
  readonly span: SourceSpan;
};

export type Program = {
  readonly kind: "Program";
  readonly version: string;
  readonly declarations: readonly Decl[];
  readonly span: SourceSpan;
};

export type Decl =
  | SourceDecl
  | UnresolvedDecl
  | ResolvedDecl
  | ReviewDecl
  | RecordDecl
  | PropositionDecl
  | ExternDecl
  | TaskDecl;

/**
 * A content-addressed source artifact used by migration tooling.
 *
 * Source declarations are provenance only: they grant no capability and
 * produce no executable AIR operation.
 */
export type SourceDecl = {
  readonly kind: "SourceDecl";
  readonly name: string;
  readonly path: string;
  readonly hash: string;
  readonly byteLength: number;
  /** Canonical RFC 4648 base64 of the exact source bytes. */
  readonly base64: string;
  readonly mapPath: string;
  readonly span: SourceSpan;
};

/**
 * A source span for which the importer could not prove executable semantics.
 *
 * This is a first-class declaration rather than a comment so the strict
 * compiler can reject it. An imported instruction can therefore never vanish
 * merely because a model classified it incorrectly.
 */
export type UnresolvedDecl = {
  readonly kind: "UnresolvedDecl";
  readonly name: string;
  readonly source: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly hash: string;
  readonly category: string;
  readonly reason: string;
  readonly span: SourceSpan;
};

/**
 * A reviewed disposition for one compiler-derived, nonblank imported span.
 *
 * This declaration is provenance, not a claim that the compiler understood
 * natural language. A reviewer either links the span to a concrete task
 * obligation or explicitly classifies it as non-normative.
 */
export type ResolvedDecl =
  | {
      readonly kind: "ResolvedDecl";
      /** The positional span ID recomputed from the embedded source. */
      readonly name: string;
      readonly source: string;
      /** Content binding: half-open byte range into the embedded source. */
      readonly byteStart: number;
      readonly byteEnd: number;
      /** SHA-256 of the exact bytes in that range. */
      readonly hash: string;
      readonly disposition: "requirement";
      readonly task: string;
      readonly obligation: string;
      readonly reason: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "ResolvedDecl";
      /** The positional span ID recomputed from the embedded source. */
      readonly name: string;
      readonly source: string;
      /** Content binding: half-open byte range into the embedded source. */
      readonly byteStart: number;
      readonly byteEnd: number;
      /** SHA-256 of the exact bytes in that range. */
      readonly hash: string;
      readonly disposition: "non_normative";
      readonly reason: string;
      readonly span: SourceSpan;
    };

/**
 * One source-wide review attestation.
 *
 * Per-span anchors give precise diagnostics. This seal additionally binds the
 * review to the complete source version and canonical disposition set so an
 * unchanged line cannot inherit a decision after its surrounding context
 * changes.
 */
export type ReviewDecl = {
  readonly kind: "ReviewDecl";
  readonly source: string;
  readonly sourceHash: string;
  readonly dispositionsHash: string;
  readonly span: SourceSpan;
};

export type RecordDecl = {
  readonly kind: "RecordDecl";
  readonly name: string;
  readonly fields: readonly FieldDecl[];
  readonly span: SourceSpan;
};

export type PropositionDecl = {
  readonly kind: "PropositionDecl";
  readonly name: string;
  /**
   * Event evidence survives until the next relevant effect; state evidence is
   * tied to the world snapshot established by a verifier.
   */
  readonly mode: "event" | "state";
  /**
   * Propositions may be nominal (`proposition Ready;`) or parameterized
   * (`proposition Ready(value: Json);`). A braced field list is accepted as a
   * readable alias for the parameterized form.
   */
  readonly parameters: readonly Parameter[];
  readonly span: SourceSpan;
};

export type ExternKind = "tool" | "model" | "validator" | "verifier";
export type ToolMode = "read" | "write";

export type ExternDecl = {
  readonly kind: "ExternDecl";
  readonly externKind: ExternKind;
  readonly name: string;
  readonly parameters: readonly Parameter[];
  /**
   * Verifiers normally use `proves` instead of a return type, so this member is
   * optional.
   */
  readonly returnType?: TypeNode;
  readonly mode?: ToolMode;
  readonly intent?: string;
  readonly proves?: TypeNode;
  readonly span: SourceSpan;
};

export type TaskDecl = {
  readonly kind: "TaskDecl";
  readonly name: string;
  readonly parameters: readonly Parameter[];
  readonly returnType: TypeNode;
  readonly obligations: readonly ObligationDecl[];
  readonly body: readonly Stmt[];
  readonly span: SourceSpan;
};

export type FieldDecl = {
  readonly kind: "FieldDecl";
  readonly name: string;
  readonly type: TypeNode;
  readonly optional: boolean;
  readonly span: SourceSpan;
};

export type Parameter = {
  readonly kind: "Parameter";
  readonly name: string;
  readonly type: TypeNode;
  readonly span: SourceSpan;
};

export type ObligationDecl = {
  readonly kind: "ObligationDecl";
  readonly id: string;
  readonly proposition: TypeNode;
  readonly span: SourceSpan;
};

export type TypeNode =
  | NamedTypeNode
  | ArrayTypeNode
  | OptionalTypeNode;

export type NamedTypeNode = {
  readonly kind: "NamedType";
  /** Dotted names are kept canonical as a single string. */
  readonly name: string;
  readonly arguments: readonly TypeNode[];
  readonly span: SourceSpan;
};

export type ArrayTypeNode = {
  readonly kind: "ArrayType";
  readonly element: TypeNode;
  readonly span: SourceSpan;
};

export type OptionalTypeNode = {
  readonly kind: "OptionalType";
  readonly inner: TypeNode;
  readonly span: SourceSpan;
};

export type Stmt =
  | ObserveStmt
  | InferStmt
  | ValidateStmt
  | ActStmt
  | VerifyStmt
  | SatisfyStmt
  | AssertStmt
  | CompleteStmt
  | FailStmt;

export type BindingStmt = {
  readonly binding: string;
  readonly expression: Expr;
};

export type ObserveStmt = BindingStmt & {
  readonly kind: "ObserveStmt";
  readonly span: SourceSpan;
};

export type InferLimits = {
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly attempts?: number;
};

export type InferStmt = BindingStmt & {
  readonly kind: "InferStmt";
  readonly limits: InferLimits;
  readonly span: SourceSpan;
};

export type ValidateStmt = BindingStmt & {
  readonly kind: "ValidateStmt";
  readonly span: SourceSpan;
};

export type ActStmt = BindingStmt & {
  readonly kind: "ActStmt";
  readonly key: Expr;
  readonly span: SourceSpan;
};

export type VerifyStmt = BindingStmt & {
  readonly kind: "VerifyStmt";
  readonly span: SourceSpan;
};

export type SatisfyStmt = {
  readonly kind: "SatisfyStmt";
  readonly obligation: string;
  readonly evidence: Expr;
  readonly span: SourceSpan;
};

export type AssertStmt = {
  readonly kind: "AssertStmt";
  readonly condition: Expr;
  readonly span: SourceSpan;
};

export type CompleteStmt = {
  readonly kind: "CompleteStmt";
  readonly value: Expr;
  readonly span: SourceSpan;
};

export type FailStmt = {
  readonly kind: "FailStmt";
  readonly reason: Expr;
  readonly span: SourceSpan;
};

export type Expr =
  | LiteralExpr
  | RefExpr
  | ArrayExpr
  | RecordExpr
  | CallExpr
  | FieldAccessExpr
  | UnaryExpr
  | BinaryExpr;

export type LiteralValue = null | boolean | number | string;

export type LiteralExpr = {
  readonly kind: "LiteralExpr";
  readonly value: LiteralValue;
  readonly raw: string;
  readonly span: SourceSpan;
};

export type RefExpr = {
  readonly kind: "RefExpr";
  readonly name: string;
  readonly span: SourceSpan;
};

export type ArrayExpr = {
  readonly kind: "ArrayExpr";
  readonly elements: readonly Expr[];
  readonly span: SourceSpan;
};

export type RecordExpr = {
  readonly kind: "RecordExpr";
  /**
   * Present for typed construction (`Plan { ... }`) and absent for an
   * anonymous record (`{ ... }`).
   */
  readonly typeName?: string;
  readonly fields: readonly RecordField[];
  readonly span: SourceSpan;
};

export type RecordField = {
  readonly kind: "RecordField";
  readonly name: string;
  readonly value: Expr;
  readonly span: SourceSpan;
};

export type CallExpr = {
  readonly kind: "CallExpr";
  readonly callee: Expr;
  readonly arguments: readonly Expr[];
  readonly span: SourceSpan;
};

export type FieldAccessExpr = {
  readonly kind: "FieldAccessExpr";
  readonly target: Expr;
  readonly field: string;
  readonly span: SourceSpan;
};

export type UnaryOperator = "!" | "-" | "+";

export type UnaryExpr = {
  readonly kind: "UnaryExpr";
  readonly operator: UnaryOperator;
  readonly operand: Expr;
  readonly span: SourceSpan;
};

export type BinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

export type BinaryExpr = {
  readonly kind: "BinaryExpr";
  readonly operator: BinaryOperator;
  readonly left: Expr;
  readonly right: Expr;
  readonly span: SourceSpan;
};
