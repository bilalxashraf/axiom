import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpTextAdapter,
  createAdapterInvocation,
  invokeAxip,
  jsonTextEnvelopeDecoder,
} from "../src/adapters.ts";
import { utf8ByteLength } from "../src/canonical.ts";
import {
  AXIP_VERSION,
  createAxipRequest,
  encodeAxoResponse,
  type AxipRequest,
} from "../src/protocol.ts";
import { schema } from "../src/schema.ts";

const PROGRAM_HASH =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const;

function requestWithOutputBudget(
  maxOutputBytes: number,
  maxInputBytes = 16_384,
): AxipRequest {
  return createAxipRequest({
    runId: "http-run",
    programHash: PROGRAM_HASH,
    nodeId: "HttpTask:1:complete",
    operation: "Return one typed answer.",
    inputSchema: schema.record([
      schema.field("prompt", schema.string()),
    ]),
    outputSchema: schema.record([
      schema.field("answer", schema.string()),
    ]),
    inputs: { prompt: "question" },
    activeObligations: [],
    allowedResponses: ["candidate", "fail"],
    budget: {
      maxInputBytes,
      maxOutputBytes,
      maxTokens: 2_048,
      maxAttempts: 1,
    },
    contextRefs: [],
  });
}

function abortAwareFetch(
  observeSignal: (signal: AbortSignal) => void = () => {},
): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal !== null && signal !== undefined);
    observeSignal(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }) as typeof globalThis.fetch;
}

function candidateText(request: AxipRequest, answer: string): string {
  return encodeAxoResponse({
    protocol: AXIP_VERSION,
    kind: "candidate",
    runId: request.runId,
    nodeId: request.nodeId,
    value: { answer },
  });
}

test("HttpTextAdapter rejects an oversized encoded request before fetch", async () => {
  const request = requestWithOutputBudget(1_024, 4_096);
  const invocation = createAdapterInvocation(request);
  const body = JSON.stringify({
    input: invocation.frame,
    padding: "💥".repeat(4_096),
  });
  assert.ok(utf8ByteLength(body) > request.budget.maxInputBytes);
  let fetchCalls = 0;
  const adapter = new HttpTextAdapter({
    endpoint: "https://model.invalid/infer",
    encodeRequest: () => ({
      body,
      headers: { "content-type": "application/json" },
    }),
    fetch: (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response("unreachable"));
    }) as typeof globalThis.fetch,
  });

  await assert.rejects(
    adapter.complete(invocation),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { readonly code?: string }).code,
        "AXIP_HTTP_REQUEST_BUDGET",
      );
      assert.match(error.message, /exceeding maxInputBytes 4096/u);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test("HttpTextAdapter budgets endpoint and headers as well as the body", async (t) => {
  const request = requestWithOutputBudget(1_024, 4_096);
  const invocation = createAdapterInvocation(request);

  for (const [name, endpoint, headers] of [
    [
      "header",
      "https://model.invalid/infer",
      { "x-model-prompt": "x".repeat(5_000) },
    ],
    [
      "endpoint query",
      `https://model.invalid/infer?prompt=${"x".repeat(5_000)}`,
      {},
    ],
  ] as const) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const adapter = new HttpTextAdapter({
        endpoint,
        encodeRequest: () => ({
          body: "x",
          headers,
        }),
        fetch: (() => {
          fetchCalls += 1;
          return Promise.resolve(new Response("unreachable"));
        }) as typeof globalThis.fetch,
      });

      await assert.rejects(
        adapter.complete(invocation),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { readonly code?: string }).code,
            "AXIP_HTTP_REQUEST_BUDGET",
          );
          assert.match(error.message, /HTTP request material/u);
          return true;
        },
      );
      assert.equal(fetchCalls, 0);
    });
  }
});

test("HttpTextAdapter fails closed on request bodies with no finite measurable size", async (t) => {
  const invocation = createAdapterInvocation(
    requestWithOutputBudget(1_024),
  );
  const form = new FormData();
  form.append("input", invocation.frame);
  const bodies: readonly (readonly [string, BodyInit])[] = [
    [
      "ReadableStream",
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(invocation.frame));
          controller.close();
        },
      }),
    ],
    ["FormData", form],
  ];

  for (const [name, body] of bodies) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const adapter = new HttpTextAdapter({
        endpoint: "https://model.invalid/infer",
        encodeRequest: () => ({ body }),
        fetch: (() => {
          fetchCalls += 1;
          return Promise.resolve(new Response("unreachable"));
        }) as typeof globalThis.fetch,
      });

      await assert.rejects(
        adapter.complete(invocation),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { readonly code?: string }).code,
            "AXIP_HTTP_REQUEST_BODY_UNBOUNDED",
          );
          return true;
        },
      );
      assert.equal(fetchCalls, 0);
    });
  }
});

test("HttpTextAdapter stops reading a streamed success body at the default output budget", async () => {
  const request = requestWithOutputBudget(96);
  const invocation = createAdapterInvocation(request);
  const chunk = new TextEncoder().encode("x".repeat(32));
  const availableChunks = 128;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls === availableChunks) {
        controller.close();
        return;
      }
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetch = (() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    )) as typeof globalThis.fetch;
  const adapter = new HttpTextAdapter({
    endpoint: "https://model.invalid/infer",
    fetch,
  });

  await assert.rejects(
    adapter.complete(invocation),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { readonly code?: string }).code,
        "AXIP_HTTP_BODY_BUDGET",
      );
      assert.match(error.message, /transport limit 96 bytes/u);
      return true;
    },
  );
  assert.equal(cancelled, true);
  assert.ok(
    pulls < availableChunks,
    `bounded reader consumed all ${pulls} available chunks`,
  );
});

test("finite HTTP envelope allowance does not relax the decoded AXO budget", async (t) => {
  const provisional = requestWithOutputBudget(4_096);
  const validAxo = candidateText(provisional, "bounded");
  const request = requestWithOutputBudget(utf8ByteLength(validAxo));
  const validEnvelope = JSON.stringify({
    provider: "portable-json",
    text: validAxo,
  });
  assert.ok(
    utf8ByteLength(validEnvelope) > request.budget.maxOutputBytes,
    "fixture must require a transport allowance larger than the AXO budget",
  );

  await t.test("decodes envelope within configured transport cap", async () => {
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      maxTransportResponseBytes: utf8ByteLength(validEnvelope),
      decodeResponse: jsonTextEnvelopeDecoder(),
      fetch: (() =>
        Promise.resolve(
          new Response(validEnvelope, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch,
    });

    const result = await invokeAxip(adapter, request);
    assert.equal(result.response.kind, "candidate");
    assert.deepEqual(
      result.response.kind === "candidate"
        ? result.response.value
        : undefined,
      { answer: "bounded" },
    );
  });

  await t.test("rejects oversized decoded AXO text", async () => {
    const oversizedAxo = candidateText(request, "x".repeat(512));
    assert.ok(
      utf8ByteLength(oversizedAxo) > request.budget.maxOutputBytes,
    );
    const oversizedEnvelope = JSON.stringify({ text: oversizedAxo });
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      maxTransportResponseBytes: utf8ByteLength(oversizedEnvelope),
      decodeResponse: jsonTextEnvelopeDecoder(),
      fetch: (() =>
        Promise.resolve(
          new Response(oversizedEnvelope, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch,
    });

    await assert.rejects(
      invokeAxip(adapter, request),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_OUTPUT_BUDGET",
        );
        return true;
      },
    );
  });
});

test("HttpTextAdapter bounds waiting with timeout and caller abort signals", async (t) => {
  const invocation = createAdapterInvocation(
    requestWithOutputBudget(1_024),
  );

  await t.test("timeout", async () => {
    let transportSignal: AbortSignal | undefined;
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      fetch: abortAwareFetch((signal) => {
        transportSignal = signal;
      }),
    });

    await assert.rejects(
      adapter.complete(invocation, { timeoutMs: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_HTTP",
        );
        assert.match(error.message, /timed out after 10ms/u);
        return true;
      },
    );
    assert.equal(transportSignal?.aborted, true);
  });

  await t.test("already-aborted caller", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    let transportSignal: AbortSignal | undefined;
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      fetch: abortAwareFetch((signal) => {
        transportSignal = signal;
      }),
    });

    await assert.rejects(
      adapter.complete(invocation, { signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_HTTP",
        );
        assert.match(error.message, /caller stopped/u);
        return true;
      },
    );
    assert.equal(transportSignal?.aborted, true);
  });

  await t.test("request encoder that ignores cancellation", async () => {
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      encodeRequest: () =>
        new Promise<never>(() => {
          // Deliberately ignores cancellation.
        }),
      fetch: (() =>
        Promise.resolve(
          new Response("unreachable"),
        )) as typeof globalThis.fetch,
    });

    await assert.rejects(
      adapter.complete(invocation, { timeoutMs: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_HTTP",
        );
        assert.match(error.message, /timed out after 10ms/u);
        return true;
      },
    );
  });

  await t.test("response decoder that ignores cancellation", async () => {
    const adapter = new HttpTextAdapter({
      endpoint: "https://model.invalid/infer",
      decodeResponse: () =>
        new Promise<never>(() => {
          // Deliberately ignores cancellation.
        }),
      fetch: (() =>
        Promise.resolve(
          new Response(candidateText(invocation.request, "ignored")),
        )) as typeof globalThis.fetch,
    });

    await assert.rejects(
      adapter.complete(invocation, { timeoutMs: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_HTTP",
        );
        assert.match(error.message, /timed out after 10ms/u);
        return true;
      },
    );
  });
});

test("invokeAxip remains bounded when an HTTP transport ignores abort", async (t) => {
  const request = requestWithOutputBudget(1_024);
  const transportSignals: AbortSignal[] = [];
  const ignoringFetch = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    if (init?.signal !== null && init?.signal !== undefined) {
      transportSignals.push(init.signal);
    }
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  const adapter = new HttpTextAdapter({
    endpoint: "https://model.invalid/infer",
    fetch: ignoringFetch,
  });

  await t.test("hard timeout", async () => {
    await assert.rejects(
      invokeAxip(adapter, request, { timeoutMs: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_TIMEOUT",
        );
        return true;
      },
    );
    // The outer AXIP deadline and the HTTP adapter's linked deadline expire
    // together. Let the latter callback propagate cancellation to fetch.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(transportSignals.at(-1)?.aborted, true);
  });

  await t.test("caller cancellation", async () => {
    const controller = new AbortController();
    const pending = invokeAxip(adapter, request, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("stop ignored transport"));

    await assert.rejects(
      pending,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { readonly code?: string }).code,
          "AXIP_ABORTED",
        );
        assert.match(error.message, /stop ignored transport/u);
        return true;
      },
    );
    assert.equal(transportSignals.at(-1)?.aborted, true);
  });
});
