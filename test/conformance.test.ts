import { deepEqual, rejects } from "node:assert/strict";
import { test } from "node:test";

import { TextFunctionAdapter } from "../src/adapters.ts";
import { checkAdapterConformance } from "../src/conformance.ts";
import {
  AXIP_PROLOGUE_HASH,
  AXIP_VERSION,
  encodeAxoResponse,
} from "../src/protocol.ts";

test("the same conformance probe works through any AXIP text adapter", async () => {
  const adapter = new TextFunctionAdapter(
    "local-text",
    (_frame, invocation) =>
      encodeAxoResponse({
        protocol: AXIP_VERSION,
        kind: "candidate",
        runId: invocation.request.runId,
        nodeId: invocation.request.nodeId,
        value: {
          nonce: (invocation.request.inputs as { readonly nonce: string }).nonce,
          protocol: "AXIP/1",
        },
      }),
    "test-model",
    [AXIP_PROLOGUE_HASH],
  );

  const result = await checkAdapterConformance(adapter, {
    nonce: "portable",
    timeoutMs: 1_000,
  });
  deepEqual(
    {
      adapterId: result.adapterId,
      model: result.model,
      prologue: result.prologue,
    },
    {
      adapterId: "local-text",
      model: "test-model",
      prologue: "reference",
    },
  );
});

test("schema-valid but instruction-incorrect adapters fail conformance", async () => {
  const adapter = new TextFunctionAdapter(
    "wrong",
    (_frame, invocation) =>
      encodeAxoResponse({
        protocol: AXIP_VERSION,
        kind: "candidate",
        runId: invocation.request.runId,
        nodeId: invocation.request.nodeId,
        value: { nonce: "changed", protocol: "AXIP/1" },
      }),
  );
  await rejects(
    checkAdapterConformance(adapter, { nonce: "expected", timeoutMs: 1_000 }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "AX2302",
  );
});
