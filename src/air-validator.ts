import { canonicalJson, unicodeScalarLength } from "./canonical.ts";
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
  PropositionMode,
} from "./ir.ts";
import {
  MAX_AXIP_TEXT_SCALARS,
  MAX_CONTROL_DEPTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_INFER_ATTEMPTS,
  MAX_REPEAT_ITERATIONS,
  MAX_TASK_EFFECT_BOUND,
  MAX_TASK_OPERATION_BOUND,
} from "./limits.ts";
import { typeEquals, typeToString } from "./types.ts";

type UnknownObject = Record<string, unknown>;

type ObligationState = {
  readonly proposition: string;
  readonly mode: PropositionMode;
  status: "pending" | "satisfied" | "stale";
};

type EvidenceState = {
  readonly proposition: string;
  readonly mode: PropositionMode;
  readonly epoch: number;
  consumed: boolean;
};

type ControlEvidenceState = {
  readonly proposition: string;
  readonly mode: PropositionMode;
  valid: boolean;
  consumed: boolean;
};

type ControlState = {
  readonly environment: Map<string, AirType>;
  readonly obligations: Map<string, ObligationState>;
  readonly evidence: Map<string, ControlEvidenceState>;
};

const BUILTIN_TYPES = new Set([
  "Bool",
  "Int",
  "Text",
  "Bytes",
  "Unit",
  "Json",
]);
const TYPE_CONSTRUCTORS = new Set(["List", "Candidate", "Evidence"]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TERMINALS = new Set(["complete", "fail"]);
const UNSUPPORTED_CORE_OPERATIONS = new Set([
  "let",
  "must",
  "if",
  "repeat",
]);
const BINARY_OPERATORS = new Set([
  "||",
  "&&",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
]);

function reject(path: string, message: string): never {
  throw new CheckError("AX1500", `Invalid AIR at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): UnknownObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    reject(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype) {
    reject(path, "expected a plain JSON object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      reject(path, "symbol properties are not part of AIR");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      reject(`${path}.${key}`, "AIR properties must be enumerable data properties");
    }
  }
  return value as UnknownObject;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    reject(path, "expected an array");
  }
  return value;
}

function exactKeys(
  value: UnknownObject,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      reject(`${path}.${key}`, "unexpected property");
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      reject(`${path}.${key}`, "missing required property");
    }
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    reject(path, "expected a string");
  }
  return value;
}

function identifierAt(value: unknown, path: string): string {
  const name = stringAt(value, path);
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    reject(path, `invalid identifier ${JSON.stringify(name)}`);
  }
  return name;
}

function integerAt(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum
  ) {
    reject(path, `expected a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function sameType(actual: AirType, expected: AirType, path: string): void {
  if (!typeEquals(actual, expected)) {
    reject(
      path,
      `expected ${typeToString(expected)}, got ${typeToString(actual)}`,
    );
  }
}

function named(name: string): AirType {
  return { kind: "named", name };
}

function containsCandidate(type: AirType): boolean {
  switch (type.kind) {
    case "candidate":
      return true;
    case "list":
      return containsCandidate(type.element);
    case "evidence":
    case "named":
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

class AirVerifier {
  private program!: AirProgram;
  private readonly records = new Map<string, AirRecord>();
  private readonly propositions = new Map<string, AirProposition>();
  private readonly ports = new Map<string, AirPort>();
  private readonly tasks = new Map<string, AirTask>();
  private readonly declarations = new Map<string, string>();

  verify(value: unknown): asserts value is AirProgram {
    try {
      canonicalJson(value);
    } catch (error) {
      reject(
        "$",
        `program is not canonical-JSON compatible: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const root = objectAt(value, "$");
    exactKeys(
      root,
      [
        "format",
        "language",
        "sourceHash",
        "records",
        "propositions",
        "ports",
        "tasks",
      ],
      "$",
    );
    const supportedPair =
      (root.format === "AIR/0.1" && root.language === "0.1") ||
      (root.format === "AIR/0.2" && root.language === "0.2");
    if (!supportedPair) {
      reject(
        "$.format",
        "expected the paired format/language AIR/0.1 + 0.1 or AIR/0.2 + 0.2",
      );
    }
    const sourceHash = stringAt(root.sourceHash, "$.sourceHash");
    if (!SHA256.test(sourceHash)) {
      reject("$.sourceHash", "expected a lowercase SHA-256 identifier");
    }

    arrayAt(root.records, "$.records");
    arrayAt(root.propositions, "$.propositions");
    arrayAt(root.ports, "$.ports");
    arrayAt(root.tasks, "$.tasks");
    this.program = root as unknown as AirProgram;

    this.collectRecords();
    this.collectPropositions();
    this.collectPorts();
    this.collectTasks();

    this.verifyRecordTypes();
    this.verifyPorts();
    this.verifyTasks();
  }

  private registerDeclaration(
    name: string,
    kind: string,
    path: string,
  ): void {
    if (BUILTIN_TYPES.has(name)) {
      reject(path, `declaration name ${JSON.stringify(name)} is a built-in type`);
    }
    const previous = this.declarations.get(name);
    if (previous !== undefined) {
      reject(
        path,
        `duplicate declaration ${JSON.stringify(name)} (already a ${previous})`,
      );
    }
    this.declarations.set(name, kind);
  }

  private collectRecords(): void {
    this.program.records.forEach((recordValue, index) => {
      const path = `$.records[${index}]`;
      const record = objectAt(recordValue, path);
      exactKeys(record, ["name", "fields"], path);
      const name = identifierAt(record.name, `${path}.name`);
      const fields = arrayAt(record.fields, `${path}.fields`);
      this.registerDeclaration(name, "record", `${path}.name`);

      const fieldNames = new Set<string>();
      fields.forEach((fieldValue, fieldIndex) => {
        const fieldPath = `${path}.fields[${fieldIndex}]`;
        const field = objectAt(fieldValue, fieldPath);
        exactKeys(field, ["name", "type"], fieldPath);
        const fieldName = identifierAt(field.name, `${fieldPath}.name`);
        if (fieldNames.has(fieldName)) {
          reject(
            `${fieldPath}.name`,
            `duplicate field ${JSON.stringify(fieldName)} in record ${JSON.stringify(name)}`,
          );
        }
        fieldNames.add(fieldName);
        objectAt(field.type, `${fieldPath}.type`);
      });

      this.records.set(name, record as unknown as AirRecord);
    });
  }

  private collectPropositions(): void {
    this.program.propositions.forEach((propositionValue, index) => {
      const path = `$.propositions[${index}]`;
      const proposition = objectAt(propositionValue, path);
      exactKeys(proposition, ["name", "mode"], path);
      const name = identifierAt(proposition.name, `${path}.name`);
      if (proposition.mode !== "event" && proposition.mode !== "state") {
        reject(`${path}.mode`, "expected \"event\" or \"state\"");
      }
      this.registerDeclaration(name, "proposition", `${path}.name`);
      this.propositions.set(name, proposition as unknown as AirProposition);
    });
  }

  private collectPorts(): void {
    this.program.ports.forEach((portValue, index) => {
      const path = `$.ports[${index}]`;
      const port = objectAt(portValue, path);
      const kind = stringAt(port.kind, `${path}.kind`);
      switch (kind) {
        case "tool":
          exactKeys(
            port,
            ["kind", "name", "mode", "parameters", "returns"],
            path,
          );
          if (port.mode !== "read" && port.mode !== "write") {
            reject(`${path}.mode`, "expected \"read\" or \"write\"");
          }
          objectAt(port.returns, `${path}.returns`);
          break;
        case "model":
          exactKeys(
            port,
            ["kind", "name", "parameters", "returns", "intent"],
            path,
          );
          objectAt(port.returns, `${path}.returns`);
          {
            const intent = stringAt(port.intent, `${path}.intent`);
            const intentLength = unicodeScalarLength(intent);
            if (intentLength === 0) {
              reject(`${path}.intent`, "model intent cannot be empty");
            }
            if (intentLength > MAX_AXIP_TEXT_SCALARS) {
              reject(
                `${path}.intent`,
                `model intent cannot exceed ${MAX_AXIP_TEXT_SCALARS} Unicode scalar values`,
              );
            }
          }
          break;
        case "validator":
          exactKeys(
            port,
            ["kind", "name", "parameters", "returns"],
            path,
          );
          objectAt(port.returns, `${path}.returns`);
          break;
        case "verifier":
          exactKeys(
            port,
            ["kind", "name", "parameters", "proposition"],
            path,
          );
          identifierAt(port.proposition, `${path}.proposition`);
          break;
        default:
          reject(`${path}.kind`, `unknown port kind ${JSON.stringify(kind)}`);
      }

      const name = identifierAt(port.name, `${path}.name`);
      this.verifyParameterShapes(port.parameters, `${path}.parameters`);
      this.registerDeclaration(name, `${kind} port`, `${path}.name`);
      this.ports.set(name, port as unknown as AirPort);
    });
  }

  private collectTasks(): void {
    this.program.tasks.forEach((taskValue, index) => {
      const path = `$.tasks[${index}]`;
      const task = objectAt(taskValue, path);
      exactKeys(
        task,
        ["name", "parameters", "returns", "obligations", "operations"],
        path,
      );
      const name = identifierAt(task.name, `${path}.name`);
      this.verifyParameterShapes(task.parameters, `${path}.parameters`);
      objectAt(task.returns, `${path}.returns`);
      arrayAt(task.obligations, `${path}.obligations`);
      arrayAt(task.operations, `${path}.operations`);
      this.registerDeclaration(name, "task", `${path}.name`);
      this.tasks.set(name, task as unknown as AirTask);
    });
  }

  private verifyParameterShapes(value: unknown, path: string): void {
    const parameters = arrayAt(value, path);
    const names = new Set<string>();
    parameters.forEach((parameterValue, index) => {
      const parameterPath = `${path}[${index}]`;
      const parameter = objectAt(parameterValue, parameterPath);
      exactKeys(parameter, ["name", "type"], parameterPath);
      const name = identifierAt(parameter.name, `${parameterPath}.name`);
      if (names.has(name)) {
        reject(
          `${parameterPath}.name`,
          `duplicate parameter ${JSON.stringify(name)}`,
        );
      }
      names.add(name);
      objectAt(parameter.type, `${parameterPath}.type`);
    });
  }

  private verifyRecordTypes(): void {
    this.program.records.forEach((record, recordIndex) => {
      record.fields.forEach((field, fieldIndex) => {
        const path = `$.records[${recordIndex}].fields[${fieldIndex}].type`;
        const type = this.verifyType(field.type, path);
        if (containsCandidate(type)) {
          reject(path, "record fields cannot contain Candidate values");
        }
        if (containsEvidence(type)) {
          reject(
            path,
            "Evidence values cannot be stored in records; only verify may mint evidence",
          );
        }
      });
    });
  }

  private verifyPorts(): void {
    this.program.ports.forEach((port, portIndex) => {
      const path = `$.ports[${portIndex}]`;
      port.parameters.forEach((parameter, parameterIndex) => {
        const typePath = `${path}.parameters[${parameterIndex}].type`;
        const type = this.verifyType(parameter.type, typePath);
        if (containsCandidate(type)) {
          if (port.kind !== "validator") {
            reject(typePath, "only validator ports may accept Candidate values");
          }
          if (
            type.kind !== "candidate" ||
            containsCandidate(type.value)
          ) {
            reject(
              typePath,
              "a Candidate must be a top-level validator parameter with a Candidate-free value type",
            );
          }
        }
        if (containsEvidence(type)) {
          reject(
            typePath,
            "Evidence values cannot cross port boundaries; only verify may mint evidence",
          );
        }
      });

      if (port.kind === "verifier") {
        if (!this.propositions.has(port.proposition)) {
          reject(
            `${path}.proposition`,
            `unknown proposition ${JSON.stringify(port.proposition)}`,
          );
        }
      } else {
        const returns = this.verifyType(port.returns, `${path}.returns`);
        if (containsCandidate(returns)) {
          reject(
            `${path}.returns`,
            "ports cannot explicitly return Candidate values",
          );
        }
        if (containsEvidence(returns)) {
          reject(
            `${path}.returns`,
            "Evidence values cannot cross port boundaries; only verify may mint evidence",
          );
        }
      }
    });
  }

  private verifyTasks(): void {
    this.program.tasks.forEach((task, taskIndex) => {
      const path = `$.tasks[${taskIndex}]`;
      const environment = new Map<string, AirType>();

      task.parameters.forEach((parameter, parameterIndex) => {
        const typePath = `${path}.parameters[${parameterIndex}].type`;
        const type = this.verifyType(parameter.type, typePath);
        if (containsCandidate(type)) {
          reject(typePath, "task parameters cannot contain Candidate values");
        }
        if (containsEvidence(type)) {
          reject(
            typePath,
            "Evidence values cannot cross task boundaries; only verify may mint evidence",
          );
        }
        environment.set(parameter.name, type);
      });

      const returns = this.verifyType(task.returns, `${path}.returns`);
      if (containsCandidate(returns)) {
        reject(`${path}.returns`, "tasks cannot return Candidate values");
      }
      if (containsEvidence(returns)) {
        reject(
          `${path}.returns`,
          "Evidence values cannot cross task boundaries; only verify may mint evidence",
        );
      }

      const obligations = this.verifyObligations(
        task,
        taskIndex,
        environment,
      );
      if (this.program.format === "AIR/0.2") {
        this.verifyControlOperations(
          task,
          taskIndex,
          environment,
          obligations,
          returns,
        );
      } else {
        this.verifyOperations(
          task,
          taskIndex,
          environment,
          obligations,
          returns,
        );
      }
    });
  }

  private verifyObligations(
    task: AirTask,
    taskIndex: number,
    environment: ReadonlyMap<string, AirType>,
  ): Map<string, ObligationState> {
    const obligations = new Map<string, ObligationState>();
    task.obligations.forEach((obligationValue, index) => {
      const path = `$.tasks[${taskIndex}].obligations[${index}]`;
      const obligation = objectAt(obligationValue, path);
      exactKeys(obligation, ["id", "proposition", "scope"], path);
      const id = identifierAt(obligation.id, `${path}.id`);
      const proposition = identifierAt(
        obligation.proposition,
        `${path}.proposition`,
      );
      if (obligation.scope !== "task") {
        reject(`${path}.scope`, "Core 0.1 obligations must have task scope");
      }
      if (obligations.has(id)) {
        reject(`${path}.id`, `duplicate obligation ${JSON.stringify(id)}`);
      }
      if (environment.has(id)) {
        reject(
          `${path}.id`,
          `obligation ${JSON.stringify(id)} conflicts with a task parameter`,
        );
      }
      const declaration = this.propositions.get(proposition);
      if (declaration === undefined) {
        reject(
          `${path}.proposition`,
          `unknown proposition ${JSON.stringify(proposition)}`,
        );
      }
      obligations.set(id, {
        proposition,
        mode: declaration.mode,
        status: "pending",
      });
    });
    return obligations;
  }

  private verifyOperations(
    task: AirTask,
    taskIndex: number,
    environment: Map<string, AirType>,
    obligations: Map<string, ObligationState>,
    returns: AirType,
  ): void {
    const basePath = `$.tasks[${taskIndex}].operations`;
    const operationObjects = task.operations.map((operation, index) => {
      const path = `${basePath}[${index}]`;
      const object = objectAt(operation, path);
      stringAt(object.op, `${path}.op`);
      return object;
    });
    const terminalIndices = operationObjects.flatMap((operation, index) =>
      TERMINALS.has(operation.op as string) ? [index] : [],
    );
    operationObjects.forEach((operation, index) => {
      const op = operation.op as string;
      if (UNSUPPORTED_CORE_OPERATIONS.has(op)) {
        reject(
          `${basePath}[${index}].op`,
          `${JSON.stringify(op)} is not an operation in certified Core 0.1`,
        );
      }
    });
    if (terminalIndices.length === 0) {
      reject(basePath, "task must contain a terminal complete or fail operation");
    }
    if (terminalIndices.length !== 1) {
      reject(basePath, "task must contain exactly one terminal operation");
    }
    if (terminalIndices[0] !== operationObjects.length - 1) {
      reject(
        `${basePath}[${terminalIndices[0] as number}]`,
        "terminal operation must be the final operation",
      );
    }

    const evidence = new Map<string, EvidenceState>();
    let worldEpoch = 0;

    operationObjects.forEach((operation, index) => {
      const path = `${basePath}[${index}]`;
      const op = operation.op as string;
      if (UNSUPPORTED_CORE_OPERATIONS.has(op)) {
        reject(
          `${path}.op`,
          `${JSON.stringify(op)} is not an operation in certified Core 0.1`,
        );
      }

      switch (op) {
        case "observe": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments"],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const port = this.requirePort(operation.port, "tool", path);
          if (port.mode !== "read") {
            reject(`${path}.port`, "observe requires a read tool port");
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            environment,
            `${path}.arguments`,
          );
          this.bind(
            operation.destination,
            port.returns,
            environment,
            `${path}.destination`,
          );
          break;
        }
        case "infer": {
          exactKeys(
            operation,
            [
              "op",
              "site",
              "destination",
              "port",
              "arguments",
              "limits",
            ],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const port = this.requirePort(operation.port, "model", path);
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            environment,
            `${path}.arguments`,
          );
          const limitsPath = `${path}.limits`;
          const limits = objectAt(operation.limits, limitsPath);
          exactKeys(
            limits,
            ["inputBytes", "outputBytes", "attempts"],
            limitsPath,
          );
          integerAt(limits.inputBytes, `${limitsPath}.inputBytes`, 1);
          integerAt(limits.outputBytes, `${limitsPath}.outputBytes`, 1);
          integerAt(limits.attempts, `${limitsPath}.attempts`, 1);
          this.bind(
            operation.destination,
            { kind: "candidate", value: port.returns },
            environment,
            `${path}.destination`,
          );
          break;
        }
        case "validate": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments"],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const port = this.requirePort(operation.port, "validator", path);
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            environment,
            `${path}.arguments`,
          );
          this.bind(
            operation.destination,
            port.returns,
            environment,
            `${path}.destination`,
          );
          break;
        }
        case "act": {
          exactKeys(
            operation,
            [
              "op",
              "site",
              "destination",
              "port",
              "arguments",
              "idempotencyKey",
            ],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const port = this.requirePort(operation.port, "tool", path);
          if (port.mode !== "write") {
            reject(`${path}.port`, "act requires a write tool port");
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            environment,
            `${path}.arguments`,
          );
          this.verifyExpression(
            operation.idempotencyKey,
            `${path}.idempotencyKey`,
            environment,
            named("Text"),
          );
          this.bind(
            operation.destination,
            port.returns,
            environment,
            `${path}.destination`,
          );
          worldEpoch += 1;
          for (const obligation of obligations.values()) {
            if (
              obligation.mode === "state" &&
              obligation.status === "satisfied"
            ) {
              obligation.status = "stale";
            }
          }
          break;
        }
        case "verify": {
          exactKeys(
            operation,
            [
              "op",
              "site",
              "destination",
              "port",
              "arguments",
              "proposition",
            ],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const port = this.requirePort(operation.port, "verifier", path);
          const proposition = identifierAt(
            operation.proposition,
            `${path}.proposition`,
          );
          if (!this.propositions.has(proposition)) {
            reject(
              `${path}.proposition`,
              `unknown proposition ${JSON.stringify(proposition)}`,
            );
          }
          if (port.proposition !== proposition) {
            reject(
              `${path}.proposition`,
              `verifier ${JSON.stringify(port.name)} proves ${JSON.stringify(port.proposition)}, not ${JSON.stringify(proposition)}`,
            );
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            environment,
            `${path}.arguments`,
          );
          const destination = this.bind(
            operation.destination,
            { kind: "evidence", proposition },
            environment,
            `${path}.destination`,
          );
          const mode = this.propositions.get(proposition)?.mode;
          if (mode === undefined) {
            reject(`${path}.proposition`, "unknown proposition");
          }
          evidence.set(destination, {
            proposition,
            mode,
            epoch: worldEpoch,
            consumed: false,
          });
          break;
        }
        case "satisfy": {
          exactKeys(
            operation,
            ["op", "site", "obligation", "evidence"],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          const obligationName = identifierAt(
            operation.obligation,
            `${path}.obligation`,
          );
          const obligation = obligations.get(obligationName);
          if (obligation === undefined) {
            reject(
              `${path}.obligation`,
              `unknown obligation ${JSON.stringify(obligationName)}`,
            );
          }
          if (obligation.status === "satisfied") {
            reject(
              `${path}.obligation`,
              `obligation ${JSON.stringify(obligationName)} is already satisfied`,
            );
          }
          const evidenceName = identifierAt(
            operation.evidence,
            `${path}.evidence`,
          );
          const proof = evidence.get(evidenceName);
          if (proof === undefined) {
            reject(
              `${path}.evidence`,
              `unknown or non-verifier evidence ${JSON.stringify(evidenceName)}`,
            );
          }
          if (proof.consumed) {
            reject(
              `${path}.evidence`,
              `evidence ${JSON.stringify(evidenceName)} has already been consumed`,
            );
          }
          if (proof.proposition !== obligation.proposition) {
            reject(
              `${path}.evidence`,
              `evidence proves ${JSON.stringify(proof.proposition)}, but obligation requires ${JSON.stringify(obligation.proposition)}`,
            );
          }
          if (proof.mode === "state" && proof.epoch !== worldEpoch) {
            reject(
              `${path}.evidence`,
              `state evidence ${JSON.stringify(evidenceName)} is stale after an act`,
            );
          }
          proof.consumed = true;
          obligation.status = "satisfied";
          break;
        }
        case "assert": {
          exactKeys(
            operation,
            ["op", "site", "condition", "message"],
            path,
          );
          this.verifySite(operation.site, index, `${path}.site`);
          if (operation.message !== "Axiom assertion failed") {
            reject(
              `${path}.message`,
              "compiler-emitted assertions use the canonical failure message",
            );
          }
          this.verifyExpression(
            operation.condition,
            `${path}.condition`,
            environment,
            named("Bool"),
          );
          break;
        }
        case "complete": {
          exactKeys(operation, ["op", "site", "value"], path);
          this.verifySite(operation.site, index, `${path}.site`);
          const unresolved = [...obligations.entries()]
            .filter(([, obligation]) => obligation.status !== "satisfied")
            .map(([id, obligation]) => `${id} (${obligation.status})`);
          if (unresolved.length !== 0) {
            reject(
              path,
              `complete has unresolved obligation(s): ${unresolved.join(", ")}`,
            );
          }
          this.verifyExpression(
            operation.value,
            `${path}.value`,
            environment,
            returns,
          );
          break;
        }
        case "fail":
          exactKeys(operation, ["op", "site", "message"], path);
          this.verifySite(operation.site, index, `${path}.site`);
          stringAt(operation.message, `${path}.message`);
          break;
        default:
          reject(`${path}.op`, `unknown operation ${JSON.stringify(op)}`);
      }
    });
  }

  /** Independently verifies the recursive, bounded AIR/0.2 control profile. */
  private verifyControlOperations(
    task: AirTask,
    taskIndex: number,
    environment: Map<string, AirType>,
    obligations: Map<string, ObligationState>,
    returns: AirType,
  ): void {
    const path = `$.tasks[${taskIndex}].operations`;
    const operations = arrayAt(task.operations, path);
    const objects = operations.map((operation, index) =>
      objectAt(operation, `${path}[${index}]`)
    );
    const terminals = objects.flatMap((operation, index) => {
      const op = stringAt(operation.op, `${path}[${index}].op`);
      return TERMINALS.has(op) ? [index] : [];
    });
    if (terminals.length !== 1) {
      reject(path, "task must contain exactly one top-level terminal operation");
    }
    if (terminals[0] !== objects.length - 1) {
      reject(
        `${path}[${terminals[0] as number}]`,
        "terminal operation must be the final top-level operation",
      );
    }

    const state: ControlState = {
      environment,
      obligations,
      evidence: new Map(),
    };
    this.verifyControlBlock(
      operations,
      path,
      state,
      returns,
      { next: 0 },
      new Set(environment.keys()),
      0,
      false,
      true,
    );
    const bounds = this.controlBounds(task.operations);
    if (bounds.operations > MAX_TASK_OPERATION_BOUND) {
      reject(
        path,
        `worst-case operation bound ${bounds.operations} exceeds ${MAX_TASK_OPERATION_BOUND}`,
      );
    }
    if (bounds.effects > MAX_TASK_EFFECT_BOUND) {
      reject(
        path,
        `worst-case effect bound ${bounds.effects} exceeds ${MAX_TASK_EFFECT_BOUND}`,
      );
    }
  }

  private verifyControlBlock(
    value: unknown,
    path: string,
    state: ControlState,
    returns: AirType,
    sites: { next: number },
    reservedBindings: Set<string>,
    depth: number,
    insideRepeat: boolean,
    topLevel: boolean,
  ): void {
    if (depth > MAX_CONTROL_DEPTH) {
      reject(path, `control-flow nesting cannot exceed ${MAX_CONTROL_DEPTH}`);
    }
    const operations = arrayAt(value, path);
    operations.forEach((operationValue, index) => {
      const operationPath = `${path}[${index}]`;
      const operation = objectAt(operationValue, operationPath);
      const op = stringAt(operation.op, `${operationPath}.op`);
      if (op === "let" || op === "must") {
        reject(
          `${operationPath}.op`,
          `${JSON.stringify(op)} is not an operation in certified Core 0.2`,
        );
      }
      if (!topLevel && op === "complete") {
        reject(
          `${operationPath}.op`,
          "complete cannot appear inside a control-flow block",
        );
      }
      if (!topLevel && op === "fail" && index !== operations.length - 1) {
        reject(
          `${operationPath}.op`,
          "fail must be the final operation in its control-flow block",
        );
      }
      if (
        insideRepeat &&
        (op === "verify" ||
          op === "satisfy" ||
          op === "complete" ||
          op === "fail")
      ) {
        reject(
          `${operationPath}.op`,
          "repeat bodies cannot contain verify, satisfy, complete, or fail",
        );
      }

      const expectedSite = sites.next;
      sites.next += 1;

      switch (op) {
        case "observe": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const port = this.requirePort(operation.port, "tool", operationPath);
          if (port.mode !== "read") {
            reject(`${operationPath}.port`, "observe requires a read tool port");
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            state.environment,
            `${operationPath}.arguments`,
          );
          this.bindControl(
            operation.destination,
            port.returns,
            state.environment,
            reservedBindings,
            `${operationPath}.destination`,
          );
          break;
        }
        case "infer": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments", "limits"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const port = this.requirePort(operation.port, "model", operationPath);
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            state.environment,
            `${operationPath}.arguments`,
          );
          const limitsPath = `${operationPath}.limits`;
          const limits = objectAt(operation.limits, limitsPath);
          exactKeys(limits, ["inputBytes", "outputBytes", "attempts"], limitsPath);
          integerAt(limits.inputBytes, `${limitsPath}.inputBytes`, 1);
          integerAt(limits.outputBytes, `${limitsPath}.outputBytes`, 1);
          const attempts = integerAt(
            limits.attempts,
            `${limitsPath}.attempts`,
            1,
          );
          if (attempts > MAX_INFER_ATTEMPTS) {
            reject(
              `${limitsPath}.attempts`,
              `Core 0.2 infer attempts cannot exceed ${MAX_INFER_ATTEMPTS}`,
            );
          }
          this.bindControl(
            operation.destination,
            { kind: "candidate", value: port.returns },
            state.environment,
            reservedBindings,
            `${operationPath}.destination`,
          );
          break;
        }
        case "validate": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const port = this.requirePort(operation.port, "validator", operationPath);
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            state.environment,
            `${operationPath}.arguments`,
          );
          this.bindControl(
            operation.destination,
            port.returns,
            state.environment,
            reservedBindings,
            `${operationPath}.destination`,
          );
          break;
        }
        case "act": {
          exactKeys(
            operation,
            [
              "op",
              "site",
              "destination",
              "port",
              "arguments",
              "idempotencyKey",
            ],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const port = this.requirePort(operation.port, "tool", operationPath);
          if (port.mode !== "write") {
            reject(`${operationPath}.port`, "act requires a write tool port");
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            state.environment,
            `${operationPath}.arguments`,
          );
          this.verifyExpression(
            operation.idempotencyKey,
            `${operationPath}.idempotencyKey`,
            state.environment,
            named("Text"),
          );
          this.bindControl(
            operation.destination,
            port.returns,
            state.environment,
            reservedBindings,
            `${operationPath}.destination`,
          );
          for (const obligation of state.obligations.values()) {
            if (
              obligation.mode === "state" &&
              obligation.status === "satisfied"
            ) {
              obligation.status = "stale";
            }
          }
          for (const proof of state.evidence.values()) {
            if (proof.mode === "state") {
              proof.valid = false;
            }
          }
          break;
        }
        case "verify": {
          exactKeys(
            operation,
            ["op", "site", "destination", "port", "arguments", "proposition"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const port = this.requirePort(operation.port, "verifier", operationPath);
          const proposition = identifierAt(
            operation.proposition,
            `${operationPath}.proposition`,
          );
          const declaration = this.propositions.get(proposition);
          if (declaration === undefined) {
            reject(`${operationPath}.proposition`, "unknown proposition");
          }
          if (port.proposition !== proposition) {
            reject(
              `${operationPath}.proposition`,
              `verifier ${JSON.stringify(port.name)} proves ${JSON.stringify(port.proposition)}, not ${JSON.stringify(proposition)}`,
            );
          }
          this.verifyArguments(
            operation.arguments,
            port.parameters,
            state.environment,
            `${operationPath}.arguments`,
          );
          const destination = this.bindControl(
            operation.destination,
            { kind: "evidence", proposition },
            state.environment,
            reservedBindings,
            `${operationPath}.destination`,
          );
          state.evidence.set(destination, {
            proposition,
            mode: declaration.mode,
            valid: true,
            consumed: false,
          });
          break;
        }
        case "satisfy": {
          exactKeys(
            operation,
            ["op", "site", "obligation", "evidence"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const obligationName = identifierAt(
            operation.obligation,
            `${operationPath}.obligation`,
          );
          const obligation = state.obligations.get(obligationName);
          if (obligation === undefined) {
            reject(`${operationPath}.obligation`, "unknown obligation");
          }
          if (obligation.status === "satisfied") {
            reject(`${operationPath}.obligation`, "obligation is already satisfied");
          }
          const evidenceName = identifierAt(
            operation.evidence,
            `${operationPath}.evidence`,
          );
          const proof = state.evidence.get(evidenceName);
          if (proof === undefined || proof.consumed) {
            reject(`${operationPath}.evidence`, "unknown or consumed verifier evidence");
          }
          if (proof.proposition !== obligation.proposition) {
            reject(`${operationPath}.evidence`, "evidence proposition does not match obligation");
          }
          if (!proof.valid) {
            reject(`${operationPath}.evidence`, "state evidence is stale after an act");
          }
          proof.consumed = true;
          obligation.status = "satisfied";
          break;
        }
        case "assert": {
          exactKeys(
            operation,
            ["op", "site", "condition", "message"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          if (operation.message !== "Axiom assertion failed") {
            reject(
              `${operationPath}.message`,
              "compiler-emitted assertions use the canonical failure message",
            );
          }
          this.verifyExpression(
            operation.condition,
            `${operationPath}.condition`,
            state.environment,
            named("Bool"),
          );
          break;
        }
        case "if": {
          exactKeys(
            operation,
            ["op", "site", "condition", "then", "otherwise"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          this.verifyExpression(
            operation.condition,
            `${operationPath}.condition`,
            state.environment,
            named("Bool"),
          );
          const thenState = this.cloneControlState(state);
          const elseState = this.cloneControlState(state);
          this.verifyControlBlock(
            operation.then,
            `${operationPath}.then`,
            thenState,
            returns,
            sites,
            reservedBindings,
            depth + 1,
            insideRepeat,
            false,
          );
          this.verifyControlBlock(
            operation.otherwise,
            `${operationPath}.otherwise`,
            elseState,
            returns,
            sites,
            reservedBindings,
            depth + 1,
            insideRepeat,
            false,
          );
          const thenContinues = this.controlBlockContinues(operation.then);
          const elseContinues = this.controlBlockContinues(operation.otherwise);
          if (!thenContinues && !elseContinues) {
            reject(
              operationPath,
              "at least one conditional branch must continue",
            );
          }
          for (const [id, obligation] of state.obligations) {
            const thenObligation = thenState.obligations.get(id);
            const elseObligation = elseState.obligations.get(id);
            if (thenObligation === undefined || elseObligation === undefined) {
              reject(operationPath, "branch lost an obligation");
            }
            if (
              thenContinues &&
              elseContinues &&
              thenObligation.status !== elseObligation.status
            ) {
              reject(
                operationPath,
                `branches leave obligation ${JSON.stringify(id)} in different states`,
              );
            }
            obligation.status = thenContinues
              ? thenObligation.status
              : elseObligation.status;
          }
          for (const [name, proof] of state.evidence) {
            const thenProof = thenState.evidence.get(name);
            const elseProof = elseState.evidence.get(name);
            if (thenProof === undefined || elseProof === undefined) {
              reject(operationPath, "branch lost pre-existing evidence state");
            }
            proof.consumed =
              (thenContinues && thenProof.consumed) ||
              (elseContinues && elseProof.consumed);
            proof.valid =
              (!thenContinues || thenProof.valid) &&
              (!elseContinues || elseProof.valid);
          }
          break;
        }
        case "repeat": {
          exactKeys(
            operation,
            ["op", "site", "maxIterations", "body", "until"],
            operationPath,
          );
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const maxIterations = integerAt(
            operation.maxIterations,
            `${operationPath}.maxIterations`,
            1,
          );
          if (maxIterations > MAX_REPEAT_ITERATIONS) {
            reject(
              `${operationPath}.maxIterations`,
              `repeat max cannot exceed ${MAX_REPEAT_ITERATIONS}`,
            );
          }
          const body = arrayAt(operation.body, `${operationPath}.body`);
          if (body.length === 0) {
            reject(`${operationPath}.body`, "repeat body cannot be empty");
          }
          const loopState = this.cloneControlState(state);
          const outerBindings = new Set(state.environment.keys());
          this.verifyControlBlock(
            body,
            `${operationPath}.body`,
            loopState,
            returns,
            sites,
            reservedBindings,
            depth + 1,
            true,
            false,
          );
          if (!this.controlBlockHasEffect(body)) {
            reject(`${operationPath}.body`, "repeat body must contain an external effect");
          }
          this.verifyExpression(
            operation.until,
            `${operationPath}.until`,
            loopState.environment,
            named("Bool"),
          );
          const localBindings = new Set(
            [...loopState.environment.keys()].filter(
              (name) => !outerBindings.has(name),
            ),
          );
          const conditionBindings = this.controlExpressionVariables(
            operation.until as AirExpr,
          );
          if (![...conditionBindings].some((name) => localBindings.has(name))) {
            reject(
              `${operationPath}.until`,
              "repeat condition must depend on a body-local binding",
            );
          }
          for (const [id, obligation] of state.obligations) {
            const loopObligation = loopState.obligations.get(id);
            if (loopObligation === undefined) {
              reject(operationPath, "repeat body lost an obligation");
            }
            obligation.status = loopObligation.status;
          }
          for (const [name, proof] of state.evidence) {
            const loopProof = loopState.evidence.get(name);
            if (loopProof === undefined) {
              reject(operationPath, "repeat body lost pre-existing evidence");
            }
            proof.consumed = loopProof.consumed;
            proof.valid = loopProof.valid;
          }
          break;
        }
        case "complete": {
          exactKeys(operation, ["op", "site", "value"], operationPath);
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          const unresolved = [...state.obligations.entries()]
            .filter(([, obligation]) => obligation.status !== "satisfied")
            .map(([id, obligation]) => `${id} (${obligation.status})`);
          if (unresolved.length !== 0) {
            reject(
              operationPath,
              `complete has unresolved obligation(s): ${unresolved.join(", ")}`,
            );
          }
          this.verifyExpression(
            operation.value,
            `${operationPath}.value`,
            state.environment,
            returns,
          );
          break;
        }
        case "fail":
          exactKeys(operation, ["op", "site", "message"], operationPath);
          this.verifySite(operation.site, expectedSite, `${operationPath}.site`);
          stringAt(operation.message, `${operationPath}.message`);
          break;
        default:
          reject(`${operationPath}.op`, `unknown operation ${JSON.stringify(op)}`);
      }
    });
  }

  private bindControl(
    value: unknown,
    type: AirType,
    environment: Map<string, AirType>,
    reservedBindings: Set<string>,
    path: string,
  ): string {
    const name = identifierAt(value, path);
    if (reservedBindings.has(name)) {
      reject(path, `duplicate immutable binding ${JSON.stringify(name)}`);
    }
    reservedBindings.add(name);
    environment.set(name, type);
    return name;
  }

  private controlBlockContinues(value: unknown): boolean {
    const operations = arrayAt(value, "$control");
    if (operations.length === 0) {
      return true;
    }
    const final = objectAt(
      operations[operations.length - 1],
      `$control[${operations.length - 1}]`,
    );
    return final.op !== "fail";
  }

  private cloneControlState(state: ControlState): ControlState {
    return {
      environment: new Map(state.environment),
      obligations: new Map(
        [...state.obligations].map(([id, obligation]) => [
          id,
          { ...obligation },
        ]),
      ),
      evidence: new Map(
        [...state.evidence].map(([name, proof]) => [name, { ...proof }]),
      ),
    };
  }

  private controlBlockHasEffect(value: readonly unknown[]): boolean {
    return value.some((operationValue, index) => {
      const operation = objectAt(operationValue, `$control[${index}]`);
      const op = stringAt(operation.op, `$control[${index}].op`);
      if (["observe", "infer", "validate", "act", "verify"].includes(op)) {
        return true;
      }
      if (op === "if") {
        return this.controlBlockHasEffect(
          arrayAt(operation.then, `$control[${index}].then`),
        ) || this.controlBlockHasEffect(
          arrayAt(operation.otherwise, `$control[${index}].otherwise`),
        );
      }
      if (op === "repeat") {
        return this.controlBlockHasEffect(
          arrayAt(operation.body, `$control[${index}].body`),
        );
      }
      return false;
    });
  }

  private controlExpressionVariables(expression: AirExpr): Set<string> {
    const variables = new Set<string>();
    const visit = (value: AirExpr): void => {
      switch (value.kind) {
        case "variable":
          variables.add(value.name);
          return;
        case "array":
          value.items.forEach(visit);
          return;
        case "record":
          value.fields.forEach((field) => visit(field.value));
          return;
        case "field":
          visit(value.target);
          return;
        case "call":
          value.arguments.forEach(visit);
          return;
        case "binary":
          visit(value.left);
          visit(value.right);
          return;
        case "literal":
          return;
      }
    };
    visit(expression);
    return variables;
  }

  private controlBounds(
    operations: readonly AirOp[],
  ): { readonly operations: number; readonly effects: number } {
    const cappedAdd = (left: number, right: number): number =>
      Math.min(MAX_TASK_EFFECT_BOUND + 1, left + right);
    const cappedMultiply = (value: number, multiplier: number): number =>
      Math.min(MAX_TASK_EFFECT_BOUND + 1, value * multiplier);
    let operationBound = 0;
    let effectBound = 0;
    for (const operation of operations) {
      let operationCost = 1;
      let effectCost = 0;
      switch (operation.op) {
        case "observe":
        case "validate":
        case "act":
        case "verify":
          effectCost = 1;
          break;
        case "infer":
          effectCost = operation.limits.attempts;
          break;
        case "if": {
          const then = this.controlBounds(operation.then);
          const otherwise = this.controlBounds(operation.otherwise);
          operationCost = cappedAdd(
            1,
            Math.max(then.operations, otherwise.operations),
          );
          effectCost = Math.max(then.effects, otherwise.effects);
          break;
        }
        case "repeat": {
          const body = this.controlBounds(operation.body);
          operationCost = cappedAdd(
            1,
            cappedMultiply(body.operations, operation.maxIterations),
          );
          effectCost = cappedMultiply(
            body.effects,
            operation.maxIterations,
          );
          break;
        }
        case "satisfy":
        case "assert":
        case "complete":
        case "fail":
          break;
      }
      operationBound = cappedAdd(operationBound, operationCost);
      effectBound = cappedAdd(effectBound, effectCost);
    }
    return { operations: operationBound, effects: effectBound };
  }

  private verifySite(value: unknown, expected: number, path: string): void {
    const site = integerAt(value, path, 0);
    if (site !== expected) {
      reject(
        path,
        `operation sites must be unique and contiguous; expected ${expected}, got ${site}`,
      );
    }
  }

  private bind(
    value: unknown,
    type: AirType,
    environment: Map<string, AirType>,
    path: string,
  ): string {
    const name = identifierAt(value, path);
    if (environment.has(name)) {
      reject(path, `duplicate immutable binding ${JSON.stringify(name)}`);
    }
    environment.set(name, type);
    return name;
  }

  private requirePort<K extends AirPort["kind"]>(
    value: unknown,
    kind: K,
    operationPath: string,
  ): Extract<AirPort, { readonly kind: K }> {
    const path = `${operationPath}.port`;
    const name = identifierAt(value, path);
    const port = this.ports.get(name);
    if (port === undefined) {
      reject(path, `unknown port ${JSON.stringify(name)}`);
    }
    if (port.kind !== kind) {
      reject(
        path,
        `expected a ${kind} port, but ${JSON.stringify(name)} is a ${port.kind} port`,
      );
    }
    return port as Extract<AirPort, { readonly kind: K }>;
  }

  private verifyArguments(
    value: unknown,
    parameters: readonly AirParameter[],
    environment: ReadonlyMap<string, AirType>,
    path: string,
  ): void {
    const arguments_ = arrayAt(value, path);
    if (arguments_.length !== parameters.length) {
      reject(
        path,
        `expected ${parameters.length} argument(s), got ${arguments_.length}`,
      );
    }
    arguments_.forEach((argument, index) => {
      const parameter = parameters[index];
      if (parameter === undefined) {
        reject(`${path}[${index}]`, "invalid parameter index");
      }
      this.verifyExpression(
        argument,
        `${path}[${index}]`,
        environment,
        parameter.type,
      );
    });
  }

  private verifyExpression(
    value: unknown,
    path: string,
    environment: ReadonlyMap<string, AirType>,
    expected?: AirType,
  ): AirType {
    const expression = objectAt(value, path);
    const kind = stringAt(expression.kind, `${path}.kind`);
    let result: AirType;

    switch (kind) {
      case "literal": {
        exactKeys(expression, ["kind", "value"], path);
        const literal = expression.value;
        if (literal === null) {
          result = named("Unit");
        } else if (typeof literal === "boolean") {
          result = named("Bool");
        } else if (typeof literal === "string") {
          result = named("Text");
        } else if (
          typeof literal === "number" &&
          Number.isSafeInteger(literal) &&
          !Object.is(literal, -0)
        ) {
          result = named("Int");
        } else {
          reject(
            `${path}.value`,
            "literals must be null, Boolean, Text, or safe integers",
          );
        }
        break;
      }
      case "variable": {
        exactKeys(expression, ["kind", "name"], path);
        const name = identifierAt(expression.name, `${path}.name`);
        const binding = environment.get(name);
        if (binding === undefined) {
          reject(`${path}.name`, `unknown binding ${JSON.stringify(name)}`);
        }
        result = binding;
        break;
      }
      case "array": {
        exactKeys(expression, ["kind", "items"], path);
        const items = arrayAt(expression.items, `${path}.items`);
        const expectedElement =
          expected?.kind === "list" ? expected.element : undefined;
        if (items.length === 0 && expectedElement === undefined) {
          reject(path, "an empty array requires an expected List type");
        }
        const itemTypes = items.map((item, index) =>
          this.verifyExpression(
            item,
            `${path}.items[${index}]`,
            environment,
            expectedElement,
          ),
        );
        const element = expectedElement ?? itemTypes[0];
        if (element === undefined) {
          reject(path, "could not infer the array element type");
        }
        itemTypes.forEach((itemType, index) =>
          sameType(itemType, element, `${path}.items[${index}]`),
        );
        result = { kind: "list", element };
        break;
      }
      case "record": {
        exactKeys(expression, ["kind", "record", "fields"], path);
        const recordName = identifierAt(
          expression.record,
          `${path}.record`,
        );
        const record = this.records.get(recordName);
        if (record === undefined) {
          reject(
            `${path}.record`,
            `unknown record type ${JSON.stringify(recordName)}`,
          );
        }
        const fields = arrayAt(expression.fields, `${path}.fields`);
        if (fields.length !== record.fields.length) {
          reject(
            `${path}.fields`,
            `record ${JSON.stringify(recordName)} must provide every declared field exactly once`,
          );
        }
        const seen = new Set<string>();
        fields.forEach((fieldValue, index) => {
          const fieldPath = `${path}.fields[${index}]`;
          const field = objectAt(fieldValue, fieldPath);
          exactKeys(field, ["name", "value"], fieldPath);
          const name = identifierAt(field.name, `${fieldPath}.name`);
          if (seen.has(name)) {
            reject(
              `${fieldPath}.name`,
              `duplicate record value field ${JSON.stringify(name)}`,
            );
          }
          seen.add(name);
          const declared = record.fields[index];
          if (declared === undefined || declared.name !== name) {
            reject(
              `${fieldPath}.name`,
              `compiler-emitted fields must follow declaration order; expected ${JSON.stringify(declared?.name)}`,
            );
          }
          this.verifyExpression(
            field.value,
            `${fieldPath}.value`,
            environment,
            declared.type,
          );
        });
        result = named(recordName);
        break;
      }
      case "field": {
        exactKeys(expression, ["kind", "target", "field"], path);
        const target = this.verifyExpression(
          expression.target,
          `${path}.target`,
          environment,
        );
        if (target.kind !== "named") {
          reject(`${path}.target`, "field access requires a record value");
        }
        const record = this.records.get(target.name);
        const fieldName = identifierAt(expression.field, `${path}.field`);
        const field = record?.fields.find(
          (candidate) => candidate.name === fieldName,
        );
        if (field === undefined) {
          reject(
            `${path}.field`,
            `type ${typeToString(target)} has no field ${JSON.stringify(fieldName)}`,
          );
        }
        result = field.type;
        break;
      }
      case "call": {
        exactKeys(expression, ["kind", "callee", "arguments"], path);
        const callee = identifierAt(
          expression.callee,
          `${path}.callee`,
        );
        const arguments_ = arrayAt(
          expression.arguments,
          `${path}.arguments`,
        );
        const argumentTypes = arguments_.map((argument, index) =>
          this.verifyExpression(
            argument,
            `${path}.arguments[${index}]`,
            environment,
          ),
        );
        if (argumentTypes.some(containsCandidate)) {
          reject(
            path,
            "Candidate values are opaque and cannot enter deterministic calls",
          );
        }
        switch (callee) {
          case "hash":
            if (argumentTypes.length !== 1) {
              reject(path, "hash expects exactly one argument");
            }
            result = named("Text");
            break;
          case "len":
            if (
              argumentTypes.length !== 1 ||
              !(
                typeEquals(argumentTypes[0] as AirType, named("Text")) ||
                argumentTypes[0]?.kind === "list"
              )
            ) {
              reject(path, "len expects exactly one Text or List argument");
            }
            result = named("Int");
            break;
          case "utf8_bytes":
            if (
              argumentTypes.length !== 1 ||
              !typeEquals(argumentTypes[0] as AirType, named("Text"))
            ) {
              reject(path, "utf8_bytes expects exactly one Text argument");
            }
            result = named("Int");
            break;
          case "contains":
            if (
              argumentTypes.length !== 2 ||
              !(
                (typeEquals(argumentTypes[0] as AirType, named("Text")) &&
                  typeEquals(argumentTypes[1] as AirType, named("Text"))) ||
                (argumentTypes[0]?.kind === "list" &&
                  typeEquals(
                    argumentTypes[0].element,
                    argumentTypes[1] as AirType,
                  ))
              )
            ) {
              reject(
                path,
                "contains expects Text/Text or List<T>/T arguments",
              );
            }
            result = named("Bool");
            break;
          case "sort": {
            const argument = argumentTypes[0];
            if (
              argumentTypes.length !== 1 ||
              argument?.kind !== "list" ||
              !(
                typeEquals(argument.element, named("Int")) ||
                typeEquals(argument.element, named("Text"))
              )
            ) {
              reject(
                path,
                "sort expects exactly one List<Int> or List<Text> argument",
              );
            }
            result = argument;
            break;
          }
          case "min":
          case "max":
            if (
              argumentTypes.length === 0 ||
              argumentTypes.some(
                (argument) => !typeEquals(argument, named("Int")),
              )
            ) {
              reject(path, `${callee} expects one or more Int arguments`);
            }
            result = named("Int");
            break;
          default:
            reject(
              `${path}.callee`,
              `unknown deterministic builtin ${JSON.stringify(callee)}`,
            );
        }
        break;
      }
      case "binary": {
        exactKeys(
          expression,
          ["kind", "operator", "left", "right"],
          path,
        );
        const operator = stringAt(
          expression.operator,
          `${path}.operator`,
        );
        if (!BINARY_OPERATORS.has(operator)) {
          reject(
            `${path}.operator`,
            `unknown binary operator ${JSON.stringify(operator)}`,
          );
        }
        const left = this.verifyExpression(
          expression.left,
          `${path}.left`,
          environment,
        );
        const right = this.verifyExpression(
          expression.right,
          `${path}.right`,
          environment,
        );
        if (containsCandidate(left) || containsCandidate(right)) {
          reject(
            path,
            "Candidate values cannot enter deterministic expressions",
          );
        }
        sameType(right, left, `${path}.right`);
        const equality = operator === "==" || operator === "!=";
        const ordering = ["<", "<=", ">", ">="].includes(operator);
        const boolean = operator === "&&" || operator === "||";
        if (boolean && !typeEquals(left, named("Bool"))) {
          reject(path, `${operator} requires Bool operands`);
        }
        if (
          ordering &&
          !typeEquals(left, named("Int")) &&
          !typeEquals(left, named("Text"))
        ) {
          reject(path, `${operator} requires Int or Text operands`);
        }
        if (
          !equality &&
          !ordering &&
          !boolean &&
          !typeEquals(left, named("Int")) &&
          !(operator === "+" && typeEquals(left, named("Text")))
        ) {
          reject(
            path,
            `${operator} does not support ${typeToString(left)} operands`,
          );
        }
        result = equality || ordering || boolean ? named("Bool") : left;
        break;
      }
      default:
        reject(`${path}.kind`, `unknown expression kind ${JSON.stringify(kind)}`);
    }

    if (expected !== undefined) {
      sameType(result, expected, path);
    }
    return result;
  }

  private verifyType(value: unknown, path: string): AirType {
    const type = objectAt(value, path);
    const kind = stringAt(type.kind, `${path}.kind`);
    switch (kind) {
      case "named": {
        exactKeys(type, ["kind", "name"], path);
        const name = identifierAt(type.name, `${path}.name`);
        if (TYPE_CONSTRUCTORS.has(name)) {
          reject(
            `${path}.name`,
            `${JSON.stringify(name)} is a type constructor and cannot be used as a named type`,
          );
        }
        if (!BUILTIN_TYPES.has(name) && !this.records.has(name)) {
          reject(`${path}.name`, `unknown type ${JSON.stringify(name)}`);
        }
        return type as unknown as AirType;
      }
      case "list":
        exactKeys(type, ["kind", "element"], path);
        return {
          kind: "list",
          element: this.verifyType(type.element, `${path}.element`),
        };
      case "candidate":
        exactKeys(type, ["kind", "value"], path);
        return {
          kind: "candidate",
          value: this.verifyType(type.value, `${path}.value`),
        };
      case "evidence": {
        exactKeys(type, ["kind", "proposition"], path);
        const proposition = identifierAt(
          type.proposition,
          `${path}.proposition`,
        );
        if (!this.propositions.has(proposition)) {
          reject(
            `${path}.proposition`,
            `unknown proposition ${JSON.stringify(proposition)}`,
          );
        }
        return { kind: "evidence", proposition };
      }
      default:
        reject(`${path}.kind`, `unknown type kind ${JSON.stringify(kind)}`);
    }
  }
}

/**
 * Verify that an unknown value is compiler-equivalent, certified AIR/0.1.
 *
 * A canonical hash authenticates bytes, not semantics. This verifier therefore
 * re-establishes the source checker's invariants before rehashed or externally
 * supplied AIR is allowed to execute.
 */
export function verifyAirProgram(
  program: unknown,
): asserts program is AirProgram {
  const verifier: AirVerifier = new AirVerifier();
  verifier.verify(program);
}
