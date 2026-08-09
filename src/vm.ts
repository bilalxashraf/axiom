import { randomUUID } from "node:crypto";

import { verifyAirProgram } from "./air-validator.ts";
import type { RuntimeBindings } from "./bindings.ts";
import {
  canonicalHash,
  canonicalJsonBytes,
  immutableJsonSnapshot,
  type JsonObject,
  type JsonValue,
  unicodeScalarLength,
  utf8ByteLength,
} from "./canonical.ts";
import { evaluateExpression } from "./evaluate.ts";
import { RuntimeError } from "./errors.ts";
import type {
  AirExpr,
  AirOp,
  AirPort,
  AirProgram,
  AirTask,
  CompiledProgram,
  PropositionMode,
} from "./ir.ts";
import { MAX_AXIP_TEXT_SCALARS } from "./limits.ts";
import {
  effectsFromLedger,
  Ledger,
  type LedgerWriter,
  type ReplayEffect,
} from "./ledger.ts";
import {
  AXIP_PROLOGUE_HASH,
  createAxipRequest,
  encodeAxipRequest,
  parseAxoResponse,
} from "./protocol.ts";
import {
  artifactProgramHash,
  semanticProgramHash,
} from "./program-hash.ts";
import { invokeAxip } from "./adapters.ts";
import {
  airTypeToSchema,
  assertValueMatchesType,
  recordDefinitionsFor,
} from "./types.ts";
import { schema } from "./schema.ts";

type ObligationRuntime = {
  readonly proposition: string;
  readonly mode: PropositionMode;
  status: "pending" | "satisfied" | "stale";
  evidenceId?: string;
};

type EvidenceRuntime = {
  readonly id: string;
  readonly proposition: string;
  readonly epoch: number;
  readonly mode: PropositionMode;
  consumed: boolean;
};

export type RunSuccess = {
  readonly status: "success";
  readonly runId: string;
  readonly programHash: string;
  readonly value: JsonValue;
  readonly ledger: Ledger;
  readonly replayedEffects: number;
};

export type RunFailure = {
  readonly status: "failed";
  readonly runId: string;
  readonly programHash: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly ledger: Ledger;
  readonly replayedEffects: number;
};

export type RunResult = RunSuccess | RunFailure;

export interface RunOptions {
  readonly task: string;
  readonly input: JsonObject;
  readonly bindings?: RuntimeBindings;
  /**
   * Host liveness cap for each model attempt. The default is 30 seconds.
   * Replays do not call a model and therefore do not consume this budget.
   */
  readonly inferenceTimeoutMs?: number;
  /**
   * Host liveness cap for each tool, validator, and verifier call. The
   * default is 30 seconds. Hosts should honor EffectContext.signal.
   */
  readonly effectTimeoutMs?: number;
  readonly runId?: string;
  readonly ledger?: Ledger;
  readonly replay?: Ledger;
}

export const DEFAULT_INFERENCE_TIMEOUT_MS = 30_000;
export const DEFAULT_EFFECT_TIMEOUT_MS = 30_000;

type OperationOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "complete"; readonly value: JsonValue };

function jsonValue(value: unknown): JsonValue {
  return immutableJsonSnapshot(value);
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return {
      code: (error as { readonly code: string }).code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    code: "AX2999",
    message: error instanceof Error ? error.message : String(error),
  };
}

class VirtualMachine {
  readonly compiled: CompiledProgram;
  readonly program: AirProgram;
  readonly task: AirTask;
  readonly bindings: RuntimeBindings | undefined;
  readonly runId: string;
  readonly ledger: Ledger;
  readonly ledgerWriter: LedgerWriter;
  readonly environment = new Map<string, JsonValue>();
  readonly obligations = new Map<string, ObligationRuntime>();
  readonly evidence = new Map<string, EvidenceRuntime>();
  readonly candidateBindings = new Set<string>();
  readonly propositionModes = new Map<string, PropositionMode>();
  readonly ports = new Map<string, AirPort>();
  readonly replayEffects: readonly ReplayEffect[];
  readonly replaySource: Ledger | undefined;
  readonly inferenceTimeoutMs: number;
  readonly effectTimeoutMs: number;
  readonly inputHash: string;
  replayCursor = 0;
  worldEpoch = 0;
  readonly iterationPath: number[] = [];

  constructor(compiled: CompiledProgram, options: RunOptions) {
    const claimedHash = compiled.hash;
    const claimedArtifactHash = compiled.artifactHash;
    const claimedBytes = Uint8Array.from(compiled.bytes);
    const program = immutableJsonSnapshot(
      compiled.program,
    ) as unknown as AirProgram;
    verifyAirProgram(program);
    const actualHash = semanticProgramHash(program);
    const actualArtifactHash = artifactProgramHash(program);
    const canonicalBytes = canonicalJsonBytes(program);
    if (
      actualHash !== claimedHash ||
      actualArtifactHash !== claimedArtifactHash ||
      Buffer.compare(Buffer.from(canonicalBytes), Buffer.from(claimedBytes)) !== 0
    ) {
      throw new RuntimeError(
        "AX2019",
        "CompiledProgram semantic hash, artifact hash, or bytes do not match its canonical AIR program",
      );
    }
    this.program = program;
    this.compiled = Object.freeze({
      hash: claimedHash,
      artifactHash: claimedArtifactHash,
      bytes: Uint8Array.from(canonicalBytes),
      program,
    });
    const task = this.program.tasks.find((candidate) => candidate.name === options.task);
    if (task === undefined) {
      throw new RuntimeError("AX2001", `Unknown task \`${options.task}\``);
    }
    this.task = task;
    this.bindings = options.bindings;
    if (this.bindings !== undefined) {
      let bindingIdLength: number;
      let adapterIdLength: number;
      try {
        bindingIdLength = unicodeScalarLength(this.bindings.id);
        adapterIdLength = unicodeScalarLength(this.bindings.model.id);
      } catch {
        throw new RuntimeError(
          "AX2134",
          "Runtime binding and model-adapter IDs must contain only Unicode scalar values",
        );
      }
      if (
        bindingIdLength === 0 ||
        bindingIdLength > MAX_AXIP_TEXT_SCALARS ||
        adapterIdLength === 0 ||
        adapterIdLength > MAX_AXIP_TEXT_SCALARS
      ) {
        throw new RuntimeError(
          "AX2134",
          `Runtime binding and model-adapter IDs must contain 1-${MAX_AXIP_TEXT_SCALARS} Unicode scalar values`,
        );
      }
      if (
        this.bindings.fingerprint !== undefined &&
        !/^sha256:[0-9a-f]{64}$/u.test(this.bindings.fingerprint)
      ) {
        throw new RuntimeError(
          "AX2135",
          "Runtime bindings fingerprint must be a lowercase SHA-256 identifier",
        );
      }
    }
    this.inferenceTimeoutMs =
      options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.inferenceTimeoutMs) ||
      this.inferenceTimeoutMs < 1
    ) {
      throw new RuntimeError(
        "AX2133",
        "inferenceTimeoutMs must be a positive safe integer",
      );
    }
    this.effectTimeoutMs =
      options.effectTimeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.effectTimeoutMs) ||
      this.effectTimeoutMs < 1
    ) {
      throw new RuntimeError(
        "AX2137",
        "effectTimeoutMs must be a positive safe integer",
      );
    }
    this.runId = options.runId ?? randomUUID();
    let runIdLength: number;
    try {
      runIdLength = unicodeScalarLength(this.runId);
    } catch {
      throw new RuntimeError(
        "AX2136",
        "runId must contain only Unicode scalar values",
      );
    }
    if (runIdLength === 0 || runIdLength > MAX_AXIP_TEXT_SCALARS) {
      throw new RuntimeError(
        "AX2136",
        `runId must contain 1-${MAX_AXIP_TEXT_SCALARS} Unicode scalar values`,
      );
    }
    this.ledger = options.ledger ?? new Ledger();
    this.replaySource = options.replay === undefined
      ? undefined
      : options.replay.detachedSnapshot();
    this.replayEffects = this.replaySource === undefined
      ? []
      : effectsFromLedger(this.replaySource);

    for (const proposition of this.program.propositions) {
      this.propositionModes.set(proposition.name, proposition.mode);
    }
    for (const port of this.program.ports) {
      this.ports.set(port.name, port);
    }
    this.initializeInputs(options.input);
    this.inputHash = canonicalHash(Object.fromEntries(this.environment));
    for (const obligation of task.obligations) {
      const mode = this.propositionModes.get(obligation.proposition);
      if (mode === undefined) {
        throw new RuntimeError(
          "AX2002",
          `Obligation \`${obligation.id}\` refers to unknown proposition \`${obligation.proposition}\``,
        );
      }
      this.obligations.set(obligation.id, {
        proposition: obligation.proposition,
        mode,
        status: "pending",
      });
    }
    this.validateReplayHeader();
    try {
      this.ledgerWriter = this.ledger.acquireExecutionWriter();
    } catch (error) {
      throw new RuntimeError(
        "AX2144",
        `Cannot acquire an empty exclusive output ledger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private initializeInputs(input: JsonObject): void {
    const expectedNames = new Set(this.task.parameters.map((parameter) => parameter.name));
    for (const key of Object.keys(input)) {
      if (!expectedNames.has(key)) {
        throw new RuntimeError("AX2003", `Unknown input \`${key}\` for task \`${this.task.name}\``);
      }
    }
    for (const parameter of this.task.parameters) {
      if (!(parameter.name in input)) {
        throw new RuntimeError("AX2004", `Missing input \`${parameter.name}\``);
      }
      const value = immutableJsonSnapshot(input[parameter.name]);
      assertValueMatchesType(value, parameter.type, this.program.records);
      this.environment.set(parameter.name, value);
      if (parameter.type.kind === "candidate") {
        this.candidateBindings.add(parameter.name);
      }
    }
  }

  private validateReplayHeader(): void {
    if (this.replaySource === undefined) {
      return;
    }
    const payload = this.replaySource.entries.find((entry) => entry.kind === "run")?.payload;
    if (payload === undefined) {
      throw new RuntimeError("AX3008", "Replay ledger has no run header");
    }
    const header = this.asObject(payload as JsonValue, "Replay run header");
    const currentInputHash = this.inputHash;
    const expectedLogFormat =
      this.program.format === "AIR/0.2" ? "AXLOG/0.2" : "AXLOG/0.1";
    if (
      header.format !== expectedLogFormat ||
      header.program_hash !== this.compiled.hash ||
      header.task !== this.task.name ||
      header.input_hash !== currentInputHash ||
      header.run_id !== this.runId
    ) {
      throw new RuntimeError(
        "AX3009",
        "Replay header does not match the program, task, input, or run ID",
      );
    }
  }

  async run(): Promise<RunResult> {
    try {
      return await this.runWithLedgerWriter();
    } finally {
      this.ledgerWriter.release();
    }
  }

  private async runWithLedgerWriter(): Promise<RunResult> {
    this.ledgerWriter.append(
      "run",
      jsonValue({
        format: this.program.format === "AIR/0.2" ? "AXLOG/0.2" : "AXLOG/0.1",
        run_id: this.runId,
        program_hash: this.compiled.hash,
        artifact_hash: this.compiled.artifactHash,
        source_hash: this.program.sourceHash,
        task: this.task.name,
        input_hash: this.inputHash,
        trusted_bindings: this.bindingProvenance(),
        mode: this.replaySource === undefined ? "live" : "replay",
      }),
    );
    try {
      const outcome = await this.executeOperations(this.task.operations);
      if (outcome.kind !== "complete") {
        throw new RuntimeError("AX2005", "Task ended without reaching complete");
      }
      if (this.replayCursor !== this.replayEffects.length) {
        throw new RuntimeError(
          "AX3005",
          `Replay contains ${this.replayEffects.length - this.replayCursor} unused effect event(s)`,
        );
      }
      const successPayload = jsonValue({
        value: outcome.value,
        world_epoch: this.worldEpoch,
        obligations: this.obligationSnapshot(),
      });
      this.validateReplayTranscript("success", successPayload);
      this.ledgerWriter.append("success", successPayload);
      return {
        status: "success",
        runId: this.runId,
        programHash: this.compiled.hash,
        value: outcome.value,
        ledger: this.ledger,
        replayedEffects: this.replayCursor,
      };
    } catch (error) {
      let details = errorDetails(error);
      let failurePayload = jsonValue({
        code: details.code,
        message: details.message,
        world_epoch: this.worldEpoch,
        obligations: this.obligationSnapshot(),
      });
      if (!details.code.startsWith("AX30")) {
        try {
          this.validateReplayTranscript("failure", failurePayload);
        } catch (transcriptError) {
          details = errorDetails(transcriptError);
          failurePayload = jsonValue({
            code: details.code,
            message: details.message,
            world_epoch: this.worldEpoch,
            obligations: this.obligationSnapshot(),
          });
        }
      }
      this.ledgerWriter.append("failure", failurePayload);
      return {
        status: "failed",
        runId: this.runId,
        programHash: this.compiled.hash,
        error: details,
        ledger: this.ledger,
        replayedEffects: this.replayCursor,
      };
    }
  }

  private obligationSnapshot(): JsonObject {
    const snapshot: Record<string, JsonValue> = {};
    for (const [id, obligation] of [...this.obligations.entries()].sort(
      ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
    )) {
      snapshot[id] = {
        proposition: obligation.proposition,
        mode: obligation.mode,
        status: obligation.status,
        evidence_id: obligation.evidenceId ?? null,
      };
    }
    return snapshot;
  }

  private bindingProvenance(): JsonValue {
    if (this.replaySource !== undefined) {
      const payload = this.replaySource.entries.find(
        (entry) => entry.kind === "run",
      )?.payload;
      if (
        payload !== null &&
        payload !== undefined &&
        !Array.isArray(payload) &&
        typeof payload === "object" &&
        "trusted_bindings" in payload
      ) {
        return payload.trusted_bindings as JsonValue;
      }
    }
    if (this.bindings !== undefined) {
      return {
        id: this.bindings.id,
        fingerprint: this.bindings.fingerprint ?? null,
        model_adapter: this.bindings.model.id,
      };
    }
    return null;
  }

  private validateReplayTranscript(
    terminalKind: "success" | "failure",
    terminalPayload: JsonValue,
  ): void {
    if (this.replaySource === undefined) {
      return;
    }
    const sourceTransitions = this.replaySource.entries
      .filter(
        (entry) =>
          entry.kind !== "run" &&
          entry.kind !== "success" &&
          entry.kind !== "failure",
      )
      .map((entry) => ({ kind: entry.kind, payload: entry.payload }));
    const replayTransitions = this.ledger.entries
      .filter(
        (entry) =>
          entry.kind !== "run" &&
          entry.kind !== "success" &&
          entry.kind !== "failure",
      )
      .map((entry) => ({ kind: entry.kind, payload: entry.payload }));
    if (
      canonicalHash(sourceTransitions) !==
      canonicalHash(replayTransitions)
    ) {
      throw new RuntimeError(
        "AX3027",
        "Replay semantic transition transcript diverged",
      );
    }
    const sourceTerminal = this.replaySource.entries.at(-1);
    if (
      sourceTerminal?.kind !== terminalKind ||
      canonicalHash(sourceTerminal.payload) !== canonicalHash(terminalPayload)
    ) {
      throw new RuntimeError(
        "AX3028",
        "Replay terminal status or payload diverged",
      );
    }
  }

  private async executeOperations(operations: readonly AirOp[]): Promise<OperationOutcome> {
    for (const operation of operations) {
      const outcome = await this.executeOperation(operation);
      if (outcome.kind === "complete") {
        return outcome;
      }
    }
    return { kind: "continue" };
  }

  private async executeOperation(operation: AirOp): Promise<OperationOutcome> {
    switch (operation.op) {
      case "observe": {
        const port = this.requirePort(operation.port, "tool");
        if (port.mode !== "read") {
          throw new RuntimeError("AX2008", `observe requires a read tool`);
        }
        const args = this.evaluatePortArguments(port, operation.arguments);
        const request = jsonValue({
          kind: "tool",
          mode: "read",
          node: this.nodeId(operation.site, operation.port),
          port: operation.port,
          arguments: args,
        });
        const response = await this.effect(request, (signal) =>
          this.requireBindings().callTool(operation.port, "read", args, {
            runId: this.runId,
            programHash: this.compiled.hash,
            nodeId: this.nodeId(operation.site, operation.port),
            signal,
          }),
        );
        const value = this.effectValue(response, operation.port);
        assertValueMatchesType(value, port.returns, this.program.records);
        this.bind(operation.destination, value);
        return { kind: "continue" };
      }
      case "infer": {
        const port = this.requirePort(operation.port, "model");
        const args = this.evaluatePortArguments(port, operation.arguments);
        const inputs: Record<string, JsonValue> = {};
        port.parameters.forEach((parameter, index) => {
          inputs[parameter.name] = args[index] as JsonValue;
        });
        const definitions = recordDefinitionsFor(this.program.records, [
          ...port.parameters.map((parameter) => parameter.type),
          port.returns,
        ]);
        const pending = [...this.obligations.entries()]
          .filter(([, obligation]) => obligation.status !== "satisfied")
          .map(([id]) => id)
          .sort();
        const request = createAxipRequest({
          runId: this.runId,
          programHash: this.compiled.hash as `sha256:${string}`,
          nodeId: this.nodeId(operation.site, operation.port),
          operation: port.intent,
          inputSchema: schema.record(
            port.parameters.map((parameter) =>
              schema.field(parameter.name, airTypeToSchema(parameter.type)),
            ),
          ),
          outputSchema: airTypeToSchema(port.returns),
          schemaDefinitions: definitions,
          inputs,
          activeObligations: pending,
          allowedResponses: ["candidate", "fail"],
          budget: {
            maxInputBytes: operation.limits.inputBytes,
            maxOutputBytes: operation.limits.outputBytes,
            maxTokens: operation.limits.inputBytes,
            maxAttempts: operation.limits.attempts,
          },
          contextRefs: [],
          prologueRef: AXIP_PROLOGUE_HASH,
        });

        let lastError: unknown;
        for (let attempt = 1; attempt <= operation.limits.attempts; attempt += 1) {
          const logicalRequest = jsonValue({
            kind: "model",
            node: request.nodeId,
            attempt,
            request,
          });
          try {
            const response = await this.effect(
              logicalRequest,
              async (signal) => {
              const model = this.requireBindings().model;
              const prologue = model.cachedPrologueRefs?.includes(
                AXIP_PROLOGUE_HASH,
              )
                ? "reference"
                : "inline";
              const frame = encodeAxipRequest(request, { prologue });
              const invoked = await invokeAxip(model, request, {
                attempt,
                timeoutMs: this.inferenceTimeoutMs,
                signal,
                prologue,
              });
              return jsonValue({
                envelope: invoked.response,
                raw: invoked.completion.text,
                adapter: invoked.completion.adapterId,
                model: invoked.completion.model ?? null,
                request_hash: invoked.requestHash,
                frame_bytes: utf8ByteLength(frame),
                response_bytes: utf8ByteLength(invoked.completion.text),
                input_tokens: invoked.completion.usage?.inputTokens ?? null,
                output_tokens: invoked.completion.usage?.outputTokens ?? null,
              });
              },
              this.inferenceTimeoutMs,
            );
            const responseObject = this.asObject(response, "Model effect response");
            let envelope = this.asObject(
              responseObject.envelope as JsonValue,
              "Model response envelope",
            );
            if (this.replaySource !== undefined) {
              if (typeof responseObject.raw !== "string") {
                throw new RuntimeError("AX3010", "Recorded model response is missing raw AXO text");
              }
              const reparsed = parseAxoResponse(responseObject.raw, request);
              if (
                canonicalHash(reparsed) !==
                canonicalHash(envelope)
              ) {
                throw new RuntimeError(
                  "AX3011",
                  "Recorded model envelope does not match its raw AXO response",
                );
              }
              envelope = this.asObject(
                jsonValue(reparsed),
                "Reparsed model response envelope",
              );
            }
            if (envelope.kind === "candidate") {
              const value = envelope.value as JsonValue;
              assertValueMatchesType(value, port.returns, this.program.records);
              this.bind(operation.destination, value, true);
              return { kind: "continue" };
            }
            if (envelope.kind === "fail") {
              const error = this.asObject(envelope.error as JsonValue, "Model failure");
              const retryable = error.retryable === true;
              const modelError = new RuntimeError(
                typeof error.code === "string" ? error.code : "AX2101",
                typeof error.message === "string"
                  ? error.message
                  : "Model rejected inference",
              );
              if (!retryable) {
                throw new RuntimeError("AX2101", modelError.message);
              }
              lastError = modelError;
              continue;
            } else {
              throw new RuntimeError("AX2102", "Context requests are not enabled in Axiom Core 0.1");
            }
          } catch (error) {
            if (
              error instanceof RuntimeError &&
              ["AX2101", "AX2102", "AX3010", "AX3011"].includes(error.code)
            ) {
              throw error;
            }
            lastError = error;
            if (attempt === operation.limits.attempts) {
              throw error;
            }
          }
        }
        throw lastError ?? new RuntimeError("AX2103", "Model inference exhausted without a result");
      }
      case "validate": {
        const port = this.requirePort(operation.port, "validator");
        const args = this.evaluatePortArguments(port, operation.arguments);
        const request = jsonValue({
          kind: "validator",
          node: this.nodeId(operation.site, operation.port),
          port: operation.port,
          arguments: args,
        });
        const response = await this.effect(request, async (signal) => ({
          value: await this.requireBindings().callValidator(operation.port, args, {
            runId: this.runId,
            programHash: this.compiled.hash,
            nodeId: this.nodeId(operation.site, operation.port),
            signal,
          }),
        }));
        const value = this.effectValue(response, operation.port);
        assertValueMatchesType(value, port.returns, this.program.records);
        this.bind(operation.destination, value);
        return { kind: "continue" };
      }
      case "act": {
        const port = this.requirePort(operation.port, "tool");
        if (port.mode !== "write") {
          throw new RuntimeError("AX2104", "act requires a write tool");
        }
        const args = this.evaluatePortArguments(port, operation.arguments);
        if (this.expressionHasCandidate(operation.idempotencyKey)) {
          throw new RuntimeError(
            "AX2124",
            "Candidate values cannot influence an action idempotency key before validation",
          );
        }
        const userKey = evaluateExpression(operation.idempotencyKey, this.environment);
        if (typeof userKey !== "string") {
          throw new RuntimeError("AX2105", "An action idempotency key must evaluate to Text");
        }
        const nodeId = this.nodeId(operation.site, operation.port);
        const idempotencyKey = canonicalHash({
          program_hash: this.compiled.hash,
          task: this.task.name,
          input_hash: this.inputHash,
          node: nodeId,
          user_key: userKey,
          arguments_hash: canonicalHash(args),
        });
        const request = jsonValue({
          kind: "tool",
          mode: "write",
          node: nodeId,
          port: operation.port,
          arguments: args,
          idempotency_key: idempotencyKey,
        });
        const response = await this.effect(request, (signal) =>
          this.requireBindings().callTool(operation.port, "write", args, {
            runId: this.runId,
            programHash: this.compiled.hash,
            nodeId,
            idempotencyKey,
            signal,
          }),
        );
        const value = this.effectValue(response, operation.port);
        assertValueMatchesType(value, port.returns, this.program.records);
        this.bind(operation.destination, value);
        this.worldEpoch += 1;
        for (const [id, obligation] of this.obligations) {
          if (obligation.mode === "state" && obligation.status === "satisfied") {
            obligation.status = "stale";
            this.recordTransition(id, "stale");
          }
        }
        return { kind: "continue" };
      }
      case "verify": {
        const port = this.requirePort(operation.port, "verifier");
        if (port.proposition !== operation.proposition) {
          throw new RuntimeError(
            "AX2132",
            `Verifier \`${port.name}\` proves \`${port.proposition}\`, not \`${operation.proposition}\``,
          );
        }
        const args = this.evaluatePortArguments(port, operation.arguments);
        const nodeId = this.nodeId(operation.site, operation.port);
        const request = jsonValue({
          kind: "verifier",
          node: nodeId,
          port: operation.port,
          proposition: operation.proposition,
          world_epoch: this.worldEpoch,
          arguments: args,
        });
        const response = await this.effect(request, async (signal) => ({
          accepted: await this.requireBindings().callVerifier(operation.port, args, {
            runId: this.runId,
            programHash: this.compiled.hash,
            nodeId,
            signal,
          }),
        }));
        const responseObject = this.asObject(response, "Verifier response");
        if (responseObject.accepted !== true) {
          throw new RuntimeError(
            "AX2106",
            `Verifier \`${operation.port}\` rejected proposition \`${operation.proposition}\``,
          );
        }
        const mode = this.propositionModes.get(operation.proposition);
        if (mode === undefined) {
          throw new RuntimeError("AX2107", `Unknown proposition \`${operation.proposition}\``);
        }
        const id = canonicalHash({
          run_id: this.runId,
          verifier: operation.port,
          proposition: operation.proposition,
          arguments_hash: canonicalHash(args),
          world_epoch: this.worldEpoch,
          ...(this.program.format === "AIR/0.1"
            ? { site: operation.site }
            : { node: nodeId }),
        });
        this.evidence.set(operation.destination, {
          id,
          proposition: operation.proposition,
          epoch: this.worldEpoch,
          mode,
          consumed: false,
        });
        this.bind(
          operation.destination,
          jsonValue({
            evidence_id: id,
            proposition: operation.proposition,
            verifier: operation.port,
            world_epoch: this.worldEpoch,
          }),
        );
        return { kind: "continue" };
      }
      case "satisfy": {
        const obligation = this.obligations.get(operation.obligation);
        const evidence = this.evidence.get(operation.evidence);
        if (obligation === undefined) {
          throw new RuntimeError("AX2108", `Unknown obligation \`${operation.obligation}\``);
        }
        if (evidence === undefined) {
          throw new RuntimeError("AX2109", `Unknown evidence \`${operation.evidence}\``);
        }
        if (evidence.consumed) {
          throw new RuntimeError("AX2110", `Evidence \`${operation.evidence}\` was already consumed`);
        }
        if (evidence.proposition !== obligation.proposition) {
          throw new RuntimeError("AX2111", "Evidence proposition does not match obligation");
        }
        if (evidence.mode === "state" && evidence.epoch !== this.worldEpoch) {
          throw new RuntimeError("AX2112", "State evidence is stale for the current world epoch");
        }
        evidence.consumed = true;
        obligation.status = "satisfied";
        obligation.evidenceId = evidence.id;
        this.recordTransition(operation.obligation, "satisfied");
        return { kind: "continue" };
      }
      case "assert": {
        if (this.expressionHasCandidate(operation.condition)) {
          throw new RuntimeError("AX2125", "Candidate values cannot control assertions");
        }
        const condition = evaluateExpression(operation.condition, this.environment);
        if (condition !== true) {
          throw new RuntimeError("AX2113", operation.message);
        }
        return { kind: "continue" };
      }
      case "if": {
        if (this.expressionHasCandidate(operation.condition)) {
          throw new RuntimeError("AX2126", "Candidate values cannot control branches");
        }
        const condition = evaluateExpression(operation.condition, this.environment);
        if (typeof condition !== "boolean") {
          throw new RuntimeError("AX2114", "if condition must evaluate to Bool");
        }
        this.ledgerWriter.append(
          "branch",
          jsonValue({
            site: operation.site,
            iterations: [...this.iterationPath],
            taken: condition ? "then" : "else",
          }),
        );
        const selected = condition ? operation.then : operation.otherwise;
        const localBindings = this.operationDestinations(selected);
        try {
          return await this.executeOperations(selected);
        } finally {
          this.clearBindings(localBindings);
        }
      }
      case "repeat": {
        const localBindings = this.operationDestinations(operation.body);
        for (
          let iteration = 1;
          iteration <= operation.maxIterations;
          iteration += 1
        ) {
          if (iteration > 1) {
            this.clearBindings(localBindings);
          }
          this.iterationPath.push(iteration);
          let outcome: OperationOutcome;
          let done: boolean;
          let iterations: readonly number[];
          try {
            iterations = [...this.iterationPath];
            outcome = await this.executeOperations(operation.body);
            if (outcome.kind === "complete") {
              throw new RuntimeError(
                "AX2141",
                "A repeat body cannot terminate the task",
              );
            }
            if (this.expressionHasCandidate(operation.until)) {
              throw new RuntimeError(
                "AX2142",
                "Candidate values cannot control repeat termination",
              );
            }
            const condition = evaluateExpression(
              operation.until,
              this.environment,
            );
            if (typeof condition !== "boolean") {
              throw new RuntimeError(
                "AX2143",
                "repeat until condition must evaluate to Bool",
              );
            }
            done = condition;
          } finally {
            this.iterationPath.pop();
          }
          this.ledgerWriter.append(
            "loop",
            jsonValue({
              site: operation.site,
              iteration,
              iterations,
              until: done,
            }),
          );
          if (done) {
            this.clearBindings(localBindings);
            return { kind: "continue" };
          }
        }
        this.clearBindings(localBindings);
        throw new RuntimeError(
          "AX2140",
          `repeat at site ${operation.site} exhausted its ${operation.maxIterations}-iteration bound`,
        );
      }
      case "complete": {
        const pending = [...this.obligations.entries()].filter(
          ([, obligation]) => obligation.status !== "satisfied",
        );
        if (pending.length !== 0) {
          throw new RuntimeError(
            "AX2115",
            `Completion blocked by obligation(s): ${pending.map(([id]) => id).join(", ")}`,
          );
        }
        if (this.expressionHasCandidate(operation.value)) {
          throw new RuntimeError("AX2127", "A task cannot complete with an unvalidated Candidate");
        }
        const value = evaluateExpression(operation.value, this.environment);
        assertValueMatchesType(value, this.task.returns, this.program.records);
        return { kind: "complete", value };
      }
      case "fail":
        throw new RuntimeError("AX2116", operation.message);
    }
  }

  private nodeId(site: number, port: string): string {
    const dynamic =
      this.iterationPath.length === 0
        ? ""
        : `@${this.iterationPath.join(".")}`;
    return `${this.task.name}:${site}${dynamic}:${port}`;
  }

  private operationDestinations(operations: readonly AirOp[]): Set<string> {
    const destinations = new Set<string>();
    const visit = (operation: AirOp): void => {
      switch (operation.op) {
        case "observe":
        case "infer":
        case "validate":
        case "act":
        case "verify":
          destinations.add(operation.destination);
          return;
        case "if":
          operation.then.forEach(visit);
          operation.otherwise.forEach(visit);
          return;
        case "repeat":
          operation.body.forEach(visit);
          return;
        case "satisfy":
        case "assert":
        case "complete":
        case "fail":
          return;
      }
    };
    operations.forEach(visit);
    return destinations;
  }

  private clearBindings(bindings: ReadonlySet<string>): void {
    for (const name of bindings) {
      this.environment.delete(name);
      this.candidateBindings.delete(name);
      this.evidence.delete(name);
    }
  }

  private bind(name: string, value: JsonValue, candidate = false): void {
    if (this.environment.has(name)) {
      throw new RuntimeError("AX2117", `Immutable runtime binding \`${name}\` already exists`);
    }
    this.environment.set(name, immutableJsonSnapshot(value));
    if (candidate) {
      this.candidateBindings.add(name);
    }
  }

  private expressionHasCandidate(expression: AirExpr): boolean {
    switch (expression.kind) {
      case "literal":
        return false;
      case "variable":
        return this.candidateBindings.has(expression.name);
      case "array":
        return expression.items.some((item) => this.expressionHasCandidate(item));
      case "record":
        return expression.fields.some((field) =>
          this.expressionHasCandidate(field.value),
        );
      case "field":
        return this.expressionHasCandidate(expression.target);
      case "call":
        return expression.arguments.some((argument) =>
          this.expressionHasCandidate(argument),
        );
      case "binary":
        return (
          this.expressionHasCandidate(expression.left) ||
          this.expressionHasCandidate(expression.right)
        );
    }
  }

  private evaluatePortArguments(
    port: AirPort,
    expressions: readonly AirExpr[],
  ): readonly JsonValue[] {
    if (expressions.length !== port.parameters.length) {
      throw new RuntimeError(
        "AX2128",
        `Port \`${port.name}\` expects ${port.parameters.length} argument(s), got ${expressions.length}`,
      );
    }
    return Object.freeze(
      expressions.map((expression, index) => {
        const parameter = port.parameters[index];
        if (parameter === undefined) {
          throw new RuntimeError("AX2129", "Port parameter index is invalid");
        }
        const candidate = this.expressionHasCandidate(expression);
        const expectsCandidate = parameter.type.kind === "candidate";
        if (candidate !== expectsCandidate) {
          throw new RuntimeError(
            "AX2130",
            candidate
              ? `Candidate value cannot flow into non-Candidate parameter \`${parameter.name}\` of \`${port.name}\``
              : `Parameter \`${parameter.name}\` of \`${port.name}\` requires Candidate input`,
          );
        }
        if (candidate && port.kind !== "validator") {
          throw new RuntimeError(
            "AX2131",
            `Only a validator may consume Candidate values; \`${port.name}\` is a ${port.kind}`,
          );
        }
        const value = evaluateExpression(expression, this.environment);
        assertValueMatchesType(value, parameter.type, this.program.records);
        return immutableJsonSnapshot(value);
      }),
    );
  }

  private requirePort<K extends AirPort["kind"]>(
    name: string,
    kind: K,
  ): Extract<AirPort, { readonly kind: K }> {
    const port = this.ports.get(name);
    if (port === undefined || port.kind !== kind) {
      throw new RuntimeError("AX2118", `Expected ${kind} port \`${name}\``);
    }
    return port as Extract<AirPort, { readonly kind: K }>;
  }

  private requireBindings(): RuntimeBindings {
    if (this.bindings === undefined) {
      throw new RuntimeError("AX2119", "Live execution requires runtime bindings");
    }
    return this.bindings;
  }

  private asObject(value: JsonValue, label: string): JsonObject {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new RuntimeError("AX2120", `${label} must be an object`);
    }
    return value as JsonObject;
  }

  private effectValue(response: JsonValue, port: string): JsonValue {
    if (this.ports.get(port)?.kind === "tool") {
      return response;
    }
    if (
      response !== null &&
      !Array.isArray(response) &&
      typeof response === "object" &&
      "value" in response
    ) {
      return response.value as JsonValue;
    }
    throw new RuntimeError("AX2121", `Effect response from \`${port}\` has no value`);
  }

  private async effect(
    request: JsonValue,
    live: (signal: AbortSignal) => Promise<JsonValue | JsonObject>,
    timeoutMs = this.effectTimeoutMs,
  ): Promise<JsonValue> {
    this.ledgerWriter.append("effect_intent", jsonValue({ request }));
    let recordedOutcome: JsonValue;
    if (this.replaySource !== undefined) {
      const recorded = this.replayEffects[this.replayCursor];
      if (recorded === undefined) {
        throw new RuntimeError("AX3006", "Replay effect tape is exhausted");
      }
      if (canonicalHash(recorded.request) !== canonicalHash(request)) {
        throw new RuntimeError(
          "AX3007",
          `Replay diverged at effect ${this.replayCursor}: request hash mismatch`,
        );
      }
      recordedOutcome = recorded.response as JsonValue;
      this.replayCursor += 1;
    } else {
      try {
        recordedOutcome = jsonValue({
          ok: true,
          value: await this.liveEffectWithinDeadline(live, timeoutMs),
        });
      } catch (error) {
        recordedOutcome = jsonValue({
          ok: false,
          error: errorDetails(error),
          uncertain: this.isUncertainWrite(request),
        });
      }
    }
    this.ledgerWriter.append("effect", jsonValue({ request, response: recordedOutcome }));
    const outcome = this.asObject(recordedOutcome, "Recorded effect outcome");
    if (outcome.ok === false) {
      const details = this.asObject(outcome.error as JsonValue, "Recorded effect error");
      throw new RuntimeError(
        typeof details.code === "string" ? details.code : "AX2122",
        typeof details.message === "string"
          ? details.message
          : "Recorded effect failed without a message",
      );
    }
    if (outcome.ok !== true || !("value" in outcome)) {
      throw new RuntimeError("AX2123", "Recorded effect outcome is malformed");
    }
    return outcome.value as JsonValue;
  }

  private isUncertainWrite(request: JsonValue): boolean {
    if (
      request !== null &&
      !Array.isArray(request) &&
      typeof request === "object"
    ) {
      const object = request as JsonObject;
      return object.kind === "tool" && object.mode === "write";
    }
    return false;
  }

  private async liveEffectWithinDeadline(
    live: (signal: AbortSignal) => Promise<JsonValue | JsonObject>,
    timeoutMs: number,
  ): Promise<JsonValue | JsonObject> {
    const controller = new AbortController();
    return new Promise<JsonValue | JsonObject>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        clearTimeout(timer);
        return true;
      };
      const resolveOnce = (value: JsonValue | JsonObject): void => {
        if (settle()) {
          resolve(value);
        }
      };
      const rejectOnce = (error: unknown): void => {
        if (settle()) {
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        const error = new RuntimeError(
          "AX2138",
          `External effect exceeded ${timeoutMs}ms`,
        );
        controller.abort(error);
        rejectOnce(error);
      }, timeoutMs);
      void Promise.resolve()
        .then(() => live(controller.signal))
        .then(
          (value) => {
            resolveOnce(value);
          },
          (error: unknown) => {
            rejectOnce(error);
          },
        );
    });
  }

  private recordTransition(obligation: string, status: string): void {
    this.ledgerWriter.append(
      "obligation",
      jsonValue({
        obligation,
        status,
        world_epoch: this.worldEpoch,
      }),
    );
  }
}

export async function runTask(
  compiled: CompiledProgram,
  options: RunOptions,
): Promise<RunResult> {
  try {
    return await new VirtualMachine(compiled, options).run();
  } catch (error) {
    const runId = options.runId ?? "uninitialized";
    let ledger = options.ledger ?? new Ledger();
    const details = errorDetails(error);
    try {
      if (ledger.entries.length !== 0) {
        throw new Error("Initialization failure cannot be appended to a nonempty output ledger");
      }
      ledger.append("failure", jsonValue(details));
    } catch {
      ledger = new Ledger();
      ledger.append("failure", jsonValue(details));
    }
    return {
      status: "failed",
      runId,
      programHash: compiled.hash,
      error: details,
      ledger,
      replayedEffects: 0,
    };
  }
}
