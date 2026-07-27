import type { JsonPrimitive, JsonValue } from "./canonical.ts";

export type { JsonPrimitive, JsonValue } from "./canonical.ts";

export type AirType =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "list"; readonly element: AirType }
  | { readonly kind: "candidate"; readonly value: AirType }
  | { readonly kind: "evidence"; readonly proposition: string };

export type AirField = {
  readonly name: string;
  readonly type: AirType;
};

export type AirRecord = {
  readonly name: string;
  readonly fields: readonly AirField[];
};

export type PropositionMode = "event" | "state";

export type AirProposition = {
  readonly name: string;
  readonly mode: PropositionMode;
};

export type AirParameter = {
  readonly name: string;
  readonly type: AirType;
};

export type AirPort =
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly mode: "read" | "write";
      readonly parameters: readonly AirParameter[];
      readonly returns: AirType;
    }
  | {
      readonly kind: "model";
      readonly name: string;
      readonly parameters: readonly AirParameter[];
      readonly returns: AirType;
      readonly intent: string;
    }
  | {
      readonly kind: "validator";
      readonly name: string;
      readonly parameters: readonly AirParameter[];
      readonly returns: AirType;
    }
  | {
      readonly kind: "verifier";
      readonly name: string;
      readonly parameters: readonly AirParameter[];
      readonly proposition: string;
    };

export type AirExpr =
  | { readonly kind: "literal"; readonly value: JsonPrimitive }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "array"; readonly items: readonly AirExpr[] }
  | {
      readonly kind: "record";
      readonly record: string;
      readonly fields: readonly { readonly name: string; readonly value: AirExpr }[];
    }
  | {
      readonly kind: "field";
      readonly target: AirExpr;
      readonly field: string;
    }
  | {
      readonly kind: "call";
      readonly callee: string;
      readonly arguments: readonly AirExpr[];
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: AirExpr;
      readonly right: AirExpr;
    };

export type InferLimits = {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly attempts: number;
};

export type AirOp =
  | {
      readonly op: "let";
      readonly site: number;
      readonly destination: string;
      readonly value: AirExpr;
    }
  | {
      readonly op: "must";
      readonly site: number;
      readonly obligation: string;
      readonly proposition: string;
    }
  | {
      readonly op: "observe";
      readonly site: number;
      readonly destination: string;
      readonly port: string;
      readonly arguments: readonly AirExpr[];
    }
  | {
      readonly op: "infer";
      readonly site: number;
      readonly destination: string;
      readonly port: string;
      readonly arguments: readonly AirExpr[];
      readonly limits: InferLimits;
    }
  | {
      readonly op: "validate";
      readonly site: number;
      readonly destination: string;
      readonly port: string;
      readonly arguments: readonly AirExpr[];
    }
  | {
      readonly op: "act";
      readonly site: number;
      readonly destination: string;
      readonly port: string;
      readonly arguments: readonly AirExpr[];
      readonly idempotencyKey: AirExpr;
    }
  | {
      readonly op: "verify";
      readonly site: number;
      readonly destination: string;
      readonly port: string;
      readonly arguments: readonly AirExpr[];
      readonly proposition: string;
    }
  | {
      readonly op: "satisfy";
      readonly site: number;
      readonly obligation: string;
      readonly evidence: string;
    }
  | {
      readonly op: "assert";
      readonly site: number;
      readonly condition: AirExpr;
      readonly message: string;
    }
  | {
      readonly op: "if";
      readonly site: number;
      readonly condition: AirExpr;
      readonly then: readonly AirOp[];
      readonly otherwise: readonly AirOp[];
    }
  | {
      readonly op: "complete";
      readonly site: number;
      readonly value: AirExpr;
    }
  | {
      readonly op: "fail";
      readonly site: number;
      readonly message: string;
    };

export type AirObligation = {
  readonly id: string;
  readonly proposition: string;
  readonly scope: "task" | "block";
};

export type AirTask = {
  readonly name: string;
  readonly parameters: readonly AirParameter[];
  readonly returns: AirType;
  readonly obligations: readonly AirObligation[];
  readonly operations: readonly AirOp[];
};

export type AirProgram = {
  readonly format: "AIR/0.1";
  readonly language: string;
  readonly sourceHash: string;
  readonly records: readonly AirRecord[];
  readonly propositions: readonly AirProposition[];
  readonly ports: readonly AirPort[];
  readonly tasks: readonly AirTask[];
};

export type CompiledProgram = {
  /** Domain-separated hash of executable semantics, excluding sourceHash. */
  readonly hash: string;
  /** Hash of the exact canonical AIR artifact, including sourceHash. */
  readonly artifactHash: string;
  readonly bytes: Uint8Array;
  readonly program: AirProgram;
};
