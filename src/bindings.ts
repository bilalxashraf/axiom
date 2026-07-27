import {
  assertJsonValue,
  canonicalEqual,
  canonicalHash,
  type JsonObject,
  type JsonValue,
} from "./canonical.ts";
import {
  FixtureAdapter,
  type AgentModelAdapter,
} from "./adapters.ts";
import { RuntimeError } from "./errors.ts";
import { AXIP_VERSION } from "./protocol.ts";

export interface EffectContext {
  readonly runId: string;
  readonly programHash: string;
  readonly nodeId: string;
  readonly idempotencyKey?: string;
  /** Aborted when the VM's inherited host-effect deadline expires. */
  readonly signal?: AbortSignal;
}

export interface RuntimeBindings {
  readonly id: string;
  /**
   * Content/package digest for the exact trusted tool, validator, and verifier
   * implementation set. Production hosts should always provide one.
   */
  readonly fingerprint?: string;
  readonly model: AgentModelAdapter;
  callTool(
    name: string,
    mode: "read" | "write",
    arguments_: readonly JsonValue[],
    context: EffectContext,
  ): Promise<JsonValue>;
  callValidator(
    name: string,
    arguments_: readonly JsonValue[],
    context: EffectContext,
  ): Promise<JsonValue>;
  callVerifier(
    name: string,
    arguments_: readonly JsonValue[],
    context: EffectContext,
  ): Promise<boolean>;
}

export type IdentityValidatorFixture = {
  readonly kind: "identity";
  readonly argument: number;
};

export type StaticValidatorFixture = {
  readonly kind: "static";
  readonly value: JsonValue;
};

export type ValidatorFixture = IdentityValidatorFixture | StaticValidatorFixture;

export type NonemptyVerifierFixture = {
  readonly kind: "nonempty";
  readonly argument: number;
  readonly path?: string;
};

export type EqualsVerifierFixture = {
  readonly kind: "equals";
  readonly argument: number;
  readonly path?: string;
  readonly value: JsonValue;
};

export type TruthyVerifierFixture = {
  readonly kind: "truthy";
  readonly argument: number;
  readonly path?: string;
};

export type VerifierFixture =
  | NonemptyVerifierFixture
  | EqualsVerifierFixture
  | TruthyVerifierFixture;

export type FixtureConfig = {
  readonly tools?: Readonly<Record<string, readonly JsonValue[]>>;
  readonly models?: Readonly<Record<string, readonly JsonValue[]>>;
  readonly validators?: Readonly<Record<string, ValidatorFixture>>;
  readonly verifiers?: Readonly<Record<string, VerifierFixture>>;
};

function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new RuntimeError("AX2201", `${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function atPath(value: JsonValue, path: string | undefined): JsonValue {
  if (path === undefined || path === "") {
    return value;
  }
  let current = value;
  for (const segment of path.split(".")) {
    const object = asObject(current, `Verifier path ${path}`);
    if (!(segment in object)) {
      throw new RuntimeError("AX2202", `Verifier path \`${path}\` does not exist`);
    }
    current = object[segment] as JsonValue;
  }
  return current;
}

function nonempty(value: JsonValue): boolean {
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}

function truthy(value: JsonValue): boolean {
  if (value === null || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function requireIndex(
  values: readonly JsonValue[],
  index: number,
  label: string,
): JsonValue {
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
    throw new RuntimeError("AX2203", `${label} refers to missing argument ${index}`);
  }
  return values[index] as JsonValue;
}

export class FixtureBindings implements RuntimeBindings {
  readonly id: string;
  readonly fingerprint: string;
  readonly model: AgentModelAdapter;
  readonly #config: FixtureConfig;
  readonly #toolCursor = new Map<string, number>();
  readonly #modelCursor = new Map<string, number>();
  readonly #writeCache = new Map<string, JsonValue>();

  constructor(config: FixtureConfig, id = "fixtures") {
    this.id = id;
    assertJsonValue(config);
    this.#config = config;
    this.fingerprint = canonicalHash(config);
    this.model = new FixtureAdapter(
      [
        {
          reusable: true,
          reply: (invocation) => {
            const name =
              invocation.request.nodeId.split(":").at(-1) ??
              invocation.request.operation;
            const outputs = this.#config.models?.[name];
            const cursor = this.#modelCursor.get(name) ?? 0;
            const value = outputs?.[cursor];
            if (value === undefined) {
              throw new RuntimeError(
                "AX2204",
                `No model fixture remains for \`${name}\` at index ${cursor}`,
              );
            }
            this.#modelCursor.set(name, cursor + 1);
            return {
              protocol: AXIP_VERSION,
              kind: "candidate",
              runId: invocation.request.runId,
              nodeId: invocation.request.nodeId,
              value,
            };
          },
        },
      ],
      `${id}:model`,
    );
  }

  async callTool(
    name: string,
    mode: "read" | "write",
    _arguments: readonly JsonValue[],
    context: EffectContext,
  ): Promise<JsonValue> {
    if (mode === "write" && context.idempotencyKey !== undefined) {
      const cached = this.#writeCache.get(context.idempotencyKey);
      if (cached !== undefined) {
        return cached;
      }
    }
    const outputs = this.#config.tools?.[name];
    const cursor = this.#toolCursor.get(name) ?? 0;
    const value = outputs?.[cursor];
    if (value === undefined) {
      throw new RuntimeError(
        "AX2205",
        `No tool fixture remains for \`${name}\` at index ${cursor}`,
      );
    }
    this.#toolCursor.set(name, cursor + 1);
    if (mode === "write" && context.idempotencyKey !== undefined) {
      this.#writeCache.set(context.idempotencyKey, value);
    }
    return value;
  }

  async callValidator(
    name: string,
    arguments_: readonly JsonValue[],
    _context: EffectContext,
  ): Promise<JsonValue> {
    const fixture = this.#config.validators?.[name];
    if (fixture === undefined) {
      throw new RuntimeError("AX2206", `No validator fixture is configured for \`${name}\``);
    }
    switch (fixture.kind) {
      case "identity":
        return requireIndex(arguments_, fixture.argument, `Validator ${name}`);
      case "static":
        return fixture.value;
    }
  }

  async callVerifier(
    name: string,
    arguments_: readonly JsonValue[],
    _context: EffectContext,
  ): Promise<boolean> {
    const fixture = this.#config.verifiers?.[name];
    if (fixture === undefined) {
      throw new RuntimeError("AX2207", `No verifier fixture is configured for \`${name}\``);
    }
    const selected = atPath(
      requireIndex(arguments_, fixture.argument, `Verifier ${name}`),
      fixture.path,
    );
    switch (fixture.kind) {
      case "nonempty":
        return nonempty(selected);
      case "equals":
        return canonicalEqual(selected, fixture.value);
      case "truthy":
        return truthy(selected);
    }
  }

}
