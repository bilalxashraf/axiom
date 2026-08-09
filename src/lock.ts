import {
  canonicalHash,
  canonicalJson,
  canonicalJsonBytes,
  immutableJsonSnapshot,
  unicodeScalarLength,
  type JsonObject,
  type JsonValue,
  type Sha256,
} from "./canonical.ts";
import { CheckError } from "./errors.ts";
import type {
  AirOp,
  AirPort,
  AirProgram,
  AirTask,
  CompiledProgram,
} from "./ir.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "./program-hash.ts";
import { MAX_AXIP_TEXT_SCALARS } from "./limits.ts";
import { AXIP_VERSION } from "./protocol.ts";
import { verifyAirProgram } from "./air-validator.ts";

export const AXIOM_TOOLCHAIN_NAME = "@axiom-lang/core";
export const AXIOM_TOOLCHAIN_VERSION = "0.3.0";
/** Frozen reference implementation identity for Core/AIR 0.1 locks. */
export const AXIOM_TOOLCHAIN_VERSION_0_1 = "0.2.0";
export const AXIOM_LOCK_FORMAT = "AXLOCK/0.1";
export const AXIOM_LOCK_FORMAT_0_2 = "AXLOCK/0.2";
export type AxiomLockFormat =
  | typeof AXIOM_LOCK_FORMAT
  | typeof AXIOM_LOCK_FORMAT_0_2;

export interface BindingLock {
  readonly id: string;
  readonly fingerprint: Sha256;
}

export interface LockedPort {
  readonly name: string;
  readonly kind: AirPort["kind"];
  readonly signature_hash: Sha256;
}

export interface LockedTask {
  readonly name: string;
  /** Exact least-authority port set inferred from executable operations. */
  readonly ports: readonly string[];
  readonly operation_bound: number;
  readonly effect_bound: number;
  readonly model_attempt_bound: number;
  readonly write_bound: number;
  readonly task_hash: Sha256;
}

export interface AxiomLock {
  readonly format: AxiomLockFormat;
  readonly toolchain: {
    readonly name: typeof AXIOM_TOOLCHAIN_NAME;
    readonly version:
      | typeof AXIOM_TOOLCHAIN_VERSION
      | typeof AXIOM_TOOLCHAIN_VERSION_0_1;
    readonly language: string;
    readonly air: string;
    readonly protocol: typeof AXIP_VERSION;
  };
  readonly program: {
    readonly semantic_hash: Sha256;
    readonly artifact_hash: Sha256;
    readonly source_hash: Sha256;
  };
  readonly binding: BindingLock | null;
  readonly ports: readonly LockedPort[];
  readonly tasks: readonly LockedTask[];
}

function operationPort(operation: AirOp): string | undefined {
  switch (operation.op) {
    case "observe":
    case "infer":
    case "validate":
    case "act":
    case "verify":
      return operation.port;
    case "satisfy":
    case "assert":
    case "complete":
    case "fail":
      return undefined;
    case "if":
    case "repeat":
      return undefined;
  }
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type Bounds = {
  readonly ports: Set<string>;
  readonly operationBound: number;
  readonly effectBound: number;
  readonly modelAttemptBound: number;
  readonly writeBound: number;
};

function emptyBounds(): Bounds {
  return {
    ports: new Set(),
    operationBound: 0,
    effectBound: 0,
    modelAttemptBound: 0,
    writeBound: 0,
  };
}

function addBounds(left: Bounds, right: Bounds, task: string): Bounds {
  return {
    ports: new Set([...left.ports, ...right.ports]),
    operationBound: checkedBoundAdd(
      left.operationBound,
      right.operationBound,
      task,
    ),
    effectBound: checkedBoundAdd(left.effectBound, right.effectBound, task),
    modelAttemptBound: checkedBoundAdd(
      left.modelAttemptBound,
      right.modelAttemptBound,
      task,
    ),
    writeBound: checkedBoundAdd(left.writeBound, right.writeBound, task),
  };
}

function branchBounds(left: Bounds, right: Bounds, task: string): Bounds {
  return {
    ports: new Set([...left.ports, ...right.ports]),
    operationBound: checkedBoundAdd(
      1,
      Math.max(left.operationBound, right.operationBound),
      task,
    ),
    effectBound: Math.max(left.effectBound, right.effectBound),
    modelAttemptBound: Math.max(
      left.modelAttemptBound,
      right.modelAttemptBound,
    ),
    writeBound: Math.max(left.writeBound, right.writeBound),
  };
}

function multiplyBounds(
  body: Bounds,
  multiplier: number,
  task: string,
): Bounds {
  return {
    ports: new Set(body.ports),
    operationBound: checkedBoundAdd(
      1,
      checkedBoundMultiply(body.operationBound, multiplier, task),
      task,
    ),
    effectBound: checkedBoundMultiply(body.effectBound, multiplier, task),
    modelAttemptBound: checkedBoundMultiply(
      body.modelAttemptBound,
      multiplier,
      task,
    ),
    writeBound: checkedBoundMultiply(body.writeBound, multiplier, task),
  };
}

function operationBounds(operation: AirOp, task: string): Bounds {
  const port = operationPort(operation);
  const ports = new Set(port === undefined ? [] : [port]);
  switch (operation.op) {
    case "observe":
    case "validate":
    case "verify":
      return {
        ports,
        operationBound: 1,
        effectBound: 1,
        modelAttemptBound: 0,
        writeBound: 0,
      };
    case "act":
      return {
        ports,
        operationBound: 1,
        effectBound: 1,
        modelAttemptBound: 0,
        writeBound: 1,
      };
    case "infer":
      return {
        ports,
        operationBound: 1,
        effectBound: operation.limits.attempts,
        modelAttemptBound: operation.limits.attempts,
        writeBound: 0,
      };
    case "if":
      return branchBounds(
        blockBounds(operation.then, task),
        blockBounds(operation.otherwise, task),
        task,
      );
    case "repeat":
      return multiplyBounds(
        blockBounds(operation.body, task),
        operation.maxIterations,
        task,
      );
    case "satisfy":
    case "assert":
    case "complete":
    case "fail":
      return {
        ports,
        operationBound: 1,
        effectBound: 0,
        modelAttemptBound: 0,
        writeBound: 0,
      };
  }
}

function blockBounds(operations: readonly AirOp[], task: string): Bounds {
  return operations.reduce(
    (total, operation) => addBounds(total, operationBounds(operation, task), task),
    emptyBounds(),
  );
}

function taskBounds(task: AirTask): Omit<LockedTask, "name" | "task_hash"> {
  const bounds = blockBounds(task.operations, task.name);
  return {
    ports: [...bounds.ports].sort(compareIdentifier),
    operation_bound: bounds.operationBound,
    effect_bound: bounds.effectBound,
    model_attempt_bound: bounds.modelAttemptBound,
    write_bound: bounds.writeBound,
  };
}

function checkedBoundMultiply(
  value: number,
  multiplier: number,
  task: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(multiplier) ||
    value < 0 ||
    multiplier < 0
  ) {
    throw new CheckError(
      "AX1607",
      `Static bound for task ${JSON.stringify(task)} requires non-negative safe integers`,
    );
  }
  const result = value * multiplier;
  if (!Number.isSafeInteger(result)) {
    throw new CheckError(
      "AX1607",
      `Static effect bound for task ${JSON.stringify(task)} exceeds the safe integer range`,
    );
  }
  return result;
}

function checkedBoundAdd(
  current: number,
  increment: number,
  task: string,
): number {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(increment) ||
    current < 0 ||
    increment < 0
  ) {
    throw new CheckError(
      "AX1606",
      `Static bound for task ${JSON.stringify(task)} requires non-negative safe integers`,
    );
  }
  const result = current + increment;
  if (!Number.isSafeInteger(result)) {
    throw new CheckError(
      "AX1606",
      `Static effect bound for task ${JSON.stringify(task)} exceeds the safe integer range`,
    );
  }
  return result;
}

function portLock(port: AirPort, air: AirProgram["format"]): LockedPort {
  return {
    name: port.name,
    kind: port.kind,
    signature_hash: canonicalHash({
      domain: air === "AIR/0.2" ? "AXIOM-PORT/0.2" : "AXIOM-PORT/0.1",
      port,
    }),
  };
}

function taskLock(task: AirTask, air: AirProgram["format"]): LockedTask {
  return {
    name: task.name,
    ...taskBounds(task),
    task_hash: canonicalHash({
      domain: air === "AIR/0.2" ? "AXIOM-TASK/0.2" : "AXIOM-TASK/0.1",
      task,
    }),
  };
}

function certifiedCompiledSnapshot(compiled: CompiledProgram): CompiledProgram {
  const claimedHash = compiled.hash;
  const claimedArtifactHash = compiled.artifactHash;
  const claimedBytes = Uint8Array.from(compiled.bytes);
  const program = immutableJsonSnapshot(
    compiled.program,
  ) as unknown as AirProgram;
  verifyAirProgram(program);
  if (
    claimedHash !== semanticProgramHash(program) ||
    claimedArtifactHash !== artifactProgramHash(program) ||
    Buffer.compare(
      Buffer.from(claimedBytes),
      Buffer.from(canonicalJsonBytes(program)),
    ) !== 0
  ) {
    throw new CheckError(
      "AX1601",
      "Cannot lock a CompiledProgram whose semantic hash, artifact hash, or bytes are invalid",
    );
  }
  return {
    hash: claimedHash,
    artifactHash: claimedArtifactHash,
    bytes: canonicalJsonBytes(program),
    program,
  };
}

export function createProgramLock(
  compiled: CompiledProgram,
  binding: BindingLock | null = null,
): AxiomLock {
  const certified = certifiedCompiledSnapshot(compiled);
  if (binding !== null) {
    let bindingIdLength: number;
    try {
      bindingIdLength = unicodeScalarLength(binding.id);
    } catch {
      throw new CheckError(
        "AX1602",
        "A locked binding ID must contain only Unicode scalar values",
      );
    }
    if (
      bindingIdLength === 0 ||
      bindingIdLength > MAX_AXIP_TEXT_SCALARS
    ) {
      throw new CheckError(
        "AX1602",
        `A locked binding ID must contain 1-${MAX_AXIP_TEXT_SCALARS} Unicode scalar values`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(binding.fingerprint)) {
      throw new CheckError(
        "AX1603",
        "A locked binding fingerprint must be a lowercase SHA-256 identifier",
      );
    }
  }
  return {
    format:
      certified.program.format === "AIR/0.2"
        ? AXIOM_LOCK_FORMAT_0_2
        : AXIOM_LOCK_FORMAT,
    toolchain: {
      name: AXIOM_TOOLCHAIN_NAME,
      version:
        certified.program.format === "AIR/0.2"
          ? AXIOM_TOOLCHAIN_VERSION
          : AXIOM_TOOLCHAIN_VERSION_0_1,
      language: certified.program.language,
      air: certified.program.format,
      protocol: AXIP_VERSION,
    },
    program: {
      semantic_hash: certified.hash as Sha256,
      artifact_hash: certified.artifactHash as Sha256,
      source_hash: certified.program.sourceHash as Sha256,
    },
    binding,
    ports: certified.program.ports
      .map((port) => portLock(port, certified.program.format))
      .sort((left, right) => compareIdentifier(left.name, right.name)),
    tasks: certified.program.tasks
      .map((task) => taskLock(task, certified.program.format))
      .sort((left, right) => compareIdentifier(left.name, right.name)),
  };
}

function asJsonLock(value: unknown): JsonValue {
  canonicalJson(value);
  return value as JsonValue;
}

/**
 * Verify an AXLOCK against a freshly compiled program and the exact trusted
 * host binding set. Equality is intentionally whole-object and fail-closed:
 * unknown or missing fields, changed limits, and changed tool signatures all
 * invalidate the lock.
 */
export function verifyProgramLock(
  value: unknown,
  compiled: CompiledProgram,
  binding: BindingLock | null = null,
): asserts value is AxiomLock {
  const actual = asJsonLock(value);
  if (
    actual === null ||
    Array.isArray(actual) ||
    typeof actual !== "object"
  ) {
    throw new CheckError(
      "AX1604",
      `Expected a canonical ${AXIOM_LOCK_FORMAT} object`,
    );
  }
  const actualObject = actual as JsonObject;
  const expectedFormat =
    compiled.program.format === "AIR/0.2"
      ? AXIOM_LOCK_FORMAT_0_2
      : AXIOM_LOCK_FORMAT;
  if (actualObject.format !== expectedFormat) {
    throw new CheckError(
      "AX1604",
      `Expected a canonical ${expectedFormat} object`,
    );
  }
  const expected = createProgramLock(compiled, binding);
  if (canonicalJson(actualObject) !== canonicalJson(expected)) {
    const actualProgram =
      typeof actualObject.program === "object" &&
      actualObject.program !== null &&
      !Array.isArray(actualObject.program)
        ? actualObject.program as JsonObject
        : undefined;
    const detail =
      actualProgram?.semantic_hash !== expected.program.semantic_hash
        ? "semantic program hash differs"
        : actualProgram?.artifact_hash !== expected.program.artifact_hash
          ? "canonical AIR artifact hash differs"
          : actualProgram?.source_hash !== expected.program.source_hash
            ? "source provenance hash differs"
            : "toolchain, binding, port contract, task capability, or bound differs";
    throw new CheckError(
      "AX1605",
      `${AXIOM_LOCK_FORMAT} verification failed: ${detail}`,
    );
  }
}
