import {
  createAdapterInvocation,
  invokeAxip,
  type AgentModelAdapter,
} from "./adapters.ts";
import {
  canonicalEqual,
  utf8ByteLength,
  type Sha256,
} from "./canonical.ts";
import { RuntimeError } from "./errors.ts";
import {
  AXIP_PROLOGUE_HASH,
  createAxipRequest,
} from "./protocol.ts";
import { schema } from "./schema.ts";

const CONFORMANCE_PROGRAM_HASH =
  "sha256:9bdd68058568ffc70a4d17462ca5c64d49d7a05b229b8227a94c0843866e9c7b" as Sha256;

export interface AdapterConformanceOptions {
  readonly nonce?: string;
  readonly timeoutMs?: number;
}

export interface AdapterConformanceResult {
  readonly adapterId: string;
  readonly model: string | null;
  readonly requestHash: Sha256;
  readonly frameBytes: number;
  readonly responseBytes: number;
  readonly prologue: "inline" | "reference";
}

/**
 * Minimal provider-neutral compatibility probe.
 *
 * This checks AXIP framing, strict typed output, identity echoing, budgets, and
 * a simple value-preservation instruction. It is not a quality benchmark.
 */
export async function checkAdapterConformance(
  adapter: AgentModelAdapter,
  options: AdapterConformanceOptions = {},
): Promise<AdapterConformanceResult> {
  const nonce = options.nonce ?? "axiom-conformance-0.1";
  if (nonce.length === 0 || utf8ByteLength(nonce) > 256) {
    throw new RangeError("Conformance nonce must contain 1-256 UTF-8 bytes");
  }
  const expected = {
    nonce,
    protocol: "AXIP/1",
  };
  const request = createAxipRequest({
    runId: "axiom-conformance",
    programHash: CONFORMANCE_PROGRAM_HASH,
    nodeId: "Conformance:0:echo",
    operation:
      "Return an object that copies the input nonce exactly and sets protocol to AXIP/1.",
    inputSchema: schema.record([
      schema.field("nonce", schema.string()),
    ]),
    outputSchema: schema.record([
      schema.field("nonce", schema.string()),
      schema.field("protocol", schema.literal("AXIP/1")),
    ]),
    inputs: { nonce },
    activeObligations: [],
    allowedResponses: ["candidate", "fail"],
    budget: {
      maxInputBytes: 4_096,
      maxOutputBytes: 1_024,
      maxTokens: 1_024,
      maxAttempts: 1,
    },
    contextRefs: [],
    prologueRef: AXIP_PROLOGUE_HASH,
  });
  const prologue = adapter.cachedPrologueRefs?.includes(AXIP_PROLOGUE_HASH)
    ? "reference"
    : "inline";
  const invocation = createAdapterInvocation(request, 1, { prologue });
  const result = await invokeAxip(adapter, request, {
    attempt: 1,
    prologue,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (result.response.kind !== "candidate") {
    throw new RuntimeError(
      "AX2301",
      result.response.kind === "fail"
        ? `Adapter conformance failed: ${result.response.error.code}: ${result.response.error.message}`
        : "Adapter conformance requested undeclared context",
    );
  }
  if (!canonicalEqual(result.response.value, expected)) {
    throw new RuntimeError(
      "AX2302",
      "Adapter returned a schema-valid value but did not preserve the conformance nonce",
    );
  }
  return {
    adapterId: result.completion.adapterId,
    model: result.completion.model ?? null,
    requestHash: result.requestHash,
    frameBytes: utf8ByteLength(invocation.frame),
    responseBytes: utf8ByteLength(result.completion.text),
    prologue,
  };
}
