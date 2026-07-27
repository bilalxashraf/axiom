import {
  canonicalHash,
  canonicalJson,
  canonicalJsonBytes,
  unicodeScalarLength,
  type JsonObject,
  type JsonValue,
  type Sha256,
} from "./canonical.ts";
import { CheckError } from "./errors.ts";
import type {
  AirOp,
  AirPort,
  AirTask,
  CompiledProgram,
} from "./ir.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "./program-hash.ts";
import { MAX_AXIP_TEXT_SCALARS } from "./limits.ts";
import { AXIP_VERSION } from "./protocol.ts";

export const AXIOM_TOOLCHAIN_NAME = "@axiom-lang/core";
export const AXIOM_TOOLCHAIN_VERSION = "0.2.0";
export const AXIOM_LOCK_FORMAT = "AXLOCK/0.1";

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
  readonly format: typeof AXIOM_LOCK_FORMAT;
  readonly toolchain: {
    readonly name: typeof AXIOM_TOOLCHAIN_NAME;
    readonly version: typeof AXIOM_TOOLCHAIN_VERSION;
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
    case "let":
    case "must":
    case "satisfy":
    case "assert":
    case "complete":
    case "fail":
      return undefined;
    case "if":
      return undefined;
  }
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function taskBounds(task: AirTask): Omit<LockedTask, "name" | "task_hash"> {
  const ports = new Set<string>();
  let effectBound = 0;
  let modelAttemptBound = 0;
  let writeBound = 0;
  for (const operation of task.operations) {
    const port = operationPort(operation);
    if (port !== undefined) {
      ports.add(port);
    }
    switch (operation.op) {
      case "observe":
      case "validate":
      case "verify":
        effectBound += 1;
        break;
      case "act":
        effectBound += 1;
        writeBound += 1;
        break;
      case "infer":
        effectBound = checkedBoundAdd(
          effectBound,
          operation.limits.attempts,
          task.name,
        );
        modelAttemptBound = checkedBoundAdd(
          modelAttemptBound,
          operation.limits.attempts,
          task.name,
        );
        break;
      case "let":
      case "must":
      case "satisfy":
      case "assert":
      case "complete":
      case "fail":
      case "if":
        break;
    }
  }
  return {
    ports: [...ports].sort(compareIdentifier),
    operation_bound: task.operations.length,
    effect_bound: effectBound,
    model_attempt_bound: modelAttemptBound,
    write_bound: writeBound,
  };
}

function checkedBoundAdd(
  current: number,
  increment: number,
  task: string,
): number {
  const result = current + increment;
  if (!Number.isSafeInteger(result)) {
    throw new CheckError(
      "AX1606",
      `Static effect bound for task ${JSON.stringify(task)} exceeds the safe integer range`,
    );
  }
  return result;
}

function portLock(port: AirPort): LockedPort {
  return {
    name: port.name,
    kind: port.kind,
    signature_hash: canonicalHash({
      domain: "AXIOM-PORT/0.1",
      port,
    }),
  };
}

function taskLock(task: AirTask): LockedTask {
  return {
    name: task.name,
    ...taskBounds(task),
    task_hash: canonicalHash({
      domain: "AXIOM-TASK/0.1",
      task,
    }),
  };
}

function assertCompiledSeals(compiled: CompiledProgram): void {
  if (
    compiled.hash !== semanticProgramHash(compiled.program) ||
    compiled.artifactHash !== artifactProgramHash(compiled.program) ||
    Buffer.compare(
      Buffer.from(compiled.bytes),
      Buffer.from(canonicalJsonBytes(compiled.program)),
    ) !== 0
  ) {
    throw new CheckError(
      "AX1601",
      "Cannot lock a CompiledProgram whose semantic hash, artifact hash, or bytes are invalid",
    );
  }
}

export function createProgramLock(
  compiled: CompiledProgram,
  binding: BindingLock | null = null,
): AxiomLock {
  assertCompiledSeals(compiled);
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
    format: AXIOM_LOCK_FORMAT,
    toolchain: {
      name: AXIOM_TOOLCHAIN_NAME,
      version: AXIOM_TOOLCHAIN_VERSION,
      language: compiled.program.language,
      air: compiled.program.format,
      protocol: AXIP_VERSION,
    },
    program: {
      semantic_hash: compiled.hash as Sha256,
      artifact_hash: compiled.artifactHash as Sha256,
      source_hash: compiled.program.sourceHash as Sha256,
    },
    binding,
    ports: compiled.program.ports
      .map(portLock)
      .sort((left, right) => compareIdentifier(left.name, right.name)),
    tasks: compiled.program.tasks
      .map(taskLock)
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
  if (actualObject.format !== AXIOM_LOCK_FORMAT) {
    throw new CheckError(
      "AX1604",
      `Expected a canonical ${AXIOM_LOCK_FORMAT} object`,
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
