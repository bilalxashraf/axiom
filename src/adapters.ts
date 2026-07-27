import {
  utf8ByteLength,
  type JsonObject,
  type JsonValue,
  type Sha256,
} from "./canonical.ts";
import { ReplayError, RuntimeError } from "./errors.ts";
import {
  axipRequestHash,
  decodeAxipRequest,
  encodeAxipRequest,
  encodeAxoResponse,
  parseAxoResponse,
  type AxipRequest,
  type AxipResponse,
  type EncodeAxipOptions,
  type ParseAxoOptions,
} from "./protocol.ts";

export interface AdapterInvocation {
  readonly request: AxipRequest;
  readonly frame: string;
  readonly requestHash: Sha256;
  readonly attempt: number;
}

export interface AdapterCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AdapterCompletion {
  readonly text: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly usage?: AdapterUsage;
  readonly metadata?: JsonObject;
}

/**
 * The complete provider contract used by the VM: text in, text out.
 *
 * Provider-native tool calls, response schemas, chat roles, and tokenizers are
 * adapter implementation details, never language semantics.
 */
export interface AgentModelAdapter {
  readonly id: string;
  /** Exact AXIP semantic prologues already installed in this model/session. */
  readonly cachedPrologueRefs?: readonly string[];
  complete(
    invocation: AdapterInvocation,
    options?: AdapterCallOptions,
  ): Promise<AdapterCompletion>;
}

export class AdapterError extends RuntimeError {}

export interface InvokeAxipOptions
  extends AdapterCallOptions,
    EncodeAxipOptions,
    ParseAxoOptions {
  readonly attempt?: number;
}

export interface AxipInvocationResult {
  readonly response: AxipResponse;
  readonly completion: AdapterCompletion;
  readonly requestHash: Sha256;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze(Reflect.get(object, key), seen);
  }
  return Object.freeze(value);
}

export function createAdapterInvocation(
  request: AxipRequest,
  attempt = 1,
  encodeOptions: EncodeAxipOptions = {},
): AdapterInvocation {
  // The frame is the transport source of truth. Decode it into a fresh,
  // deeply frozen semantic snapshot so an adapter cannot alter schemas,
  // identities, budgets, or hash meaning after invocation creation.
  const frame = encodeAxipRequest(request, encodeOptions);
  const snapshot = deepFreeze(decodeAxipRequest(frame));
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > snapshot.budget.maxAttempts
  ) {
    throw new AdapterError(
      "AXIP_ATTEMPT",
      `Attempt ${attempt} is outside the request budget 1-${snapshot.budget.maxAttempts}`,
    );
  }
  return Object.freeze({
    request: snapshot,
    frame,
    requestHash: axipRequestHash(snapshot),
    attempt,
  });
}

async function completeWithinBudget(
  adapter: AgentModelAdapter,
  invocation: AdapterInvocation,
  options: AdapterCallOptions,
): Promise<AdapterCompletion> {
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return adapter.complete(invocation, options);
  }
  return new Promise<AdapterCompletion>((resolve, reject) => {
    let settled = false;
    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", abort);
      return true;
    };
    const resolveOnce = (completion: AdapterCompletion): void => {
      if (cleanup()) {
        resolve(completion);
      }
    };
    const rejectOnce = (error: unknown): void => {
      if (cleanup()) {
        reject(error);
      }
    };
    const abort = (): void => {
      rejectOnce(
        new AdapterError(
          "AXIP_ABORTED",
          options.signal?.reason instanceof Error
            ? options.signal.reason.message
            : "Model invocation was aborted",
        ),
      );
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            rejectOnce(
              new AdapterError(
                "AXIP_TIMEOUT",
                `Adapter ${JSON.stringify(adapter.id)} exceeded ${options.timeoutMs}ms`,
              ),
            );
          }, options.timeoutMs);
    if (options.signal?.aborted === true) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => adapter.complete(invocation, options))
      .then(
        (completion) => {
          resolveOnce(completion);
        },
        (error: unknown) => {
          rejectOnce(error);
        },
      );
  });
}

export async function invokeAxip(
  adapter: AgentModelAdapter,
  request: AxipRequest,
  options: InvokeAxipOptions = {},
): Promise<AxipInvocationResult> {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const invocation = createAdapterInvocation(
    request,
    options.attempt ?? 1,
    options.prologue === undefined
      ? {}
      : { prologue: options.prologue },
  );
  const completion = await completeWithinBudget(adapter, invocation, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(timeoutMs === undefined
      ? {}
      : { timeoutMs }),
  });
  const normalizedRequest = invocation.request;
  if (
    utf8ByteLength(completion.text) >
    normalizedRequest.budget.maxOutputBytes
  ) {
    throw new AdapterError(
      "AXIP_OUTPUT_BUDGET",
      `Adapter ${JSON.stringify(adapter.id)} returned ${utf8ByteLength(
        completion.text,
      )} bytes, exceeding maxOutputBytes ${normalizedRequest.budget.maxOutputBytes}`,
    );
  }
  const response = parseAxoResponse(completion.text, normalizedRequest, {
    ...(options.requireCanonicalJson === undefined
      ? {}
      : { requireCanonicalJson: options.requireCanonicalJson }),
  });
  return {
    response,
    completion,
    requestHash: invocation.requestHash,
  };
}

export type TextCompletionFunction = (
  frame: string,
  invocation: AdapterInvocation,
  options: AdapterCallOptions,
) => string | Promise<string>;

/**
 * Small bridge for SDKs and local models: wrap any text-completion function
 * without teaching the VM about that provider.
 */
export class TextFunctionAdapter implements AgentModelAdapter {
  readonly id: string;
  readonly model: string | undefined;
  readonly cachedPrologueRefs: readonly string[];
  readonly #completeText: TextCompletionFunction;

  constructor(
    id: string,
    completeText: TextCompletionFunction,
    model?: string,
    cachedPrologueRefs: readonly string[] = [],
  ) {
    if (id.length === 0) {
      throw new TypeError("Adapter id cannot be empty");
    }
    this.id = id;
    this.#completeText = completeText;
    this.model = model;
    this.cachedPrologueRefs = [...cachedPrologueRefs];
  }

  async complete(
    invocation: AdapterInvocation,
    options: AdapterCallOptions = {},
  ): Promise<AdapterCompletion> {
    const text = await this.#completeText(
      invocation.frame,
      invocation,
      options,
    );
    if (typeof text !== "string") {
      throw new AdapterError(
        "AXIP_ADAPTER_TEXT",
        `Adapter ${JSON.stringify(this.id)} did not return text`,
      );
    }
    return {
      text,
      adapterId: this.id,
      ...(this.model === undefined ? {} : { model: this.model }),
    };
  }
}

export interface FixtureMatch {
  readonly requestHash?: Sha256;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly operation?: string;
  readonly attempt?: number;
}

export type FixtureReply =
  | string
  | AxipResponse
  | ((
      invocation: AdapterInvocation,
    ) => string | AxipResponse | Promise<string | AxipResponse>);

export interface AdapterFixture {
  /**
   * Omitted match is a deterministic queue fixture: it matches the next call.
   */
  readonly match?: FixtureMatch;
  readonly reply: FixtureReply;
  /**
   * Reusable fixtures are not consumed. Non-reusable fixtures match once.
   */
  readonly reusable?: boolean;
}

function fixtureMatches(
  match: FixtureMatch | undefined,
  invocation: AdapterInvocation,
): boolean {
  if (match === undefined) {
    return true;
  }
  return (
    (match.requestHash === undefined ||
      match.requestHash === invocation.requestHash) &&
    (match.runId === undefined || match.runId === invocation.request.runId) &&
    (match.nodeId === undefined ||
      match.nodeId === invocation.request.nodeId) &&
    (match.operation === undefined ||
      match.operation === invocation.request.operation) &&
    (match.attempt === undefined || match.attempt === invocation.attempt)
  );
}

/**
 * Deterministic in-memory adapter for conformance tests and offline runs.
 */
export class FixtureAdapter implements AgentModelAdapter {
  readonly id: string;
  readonly #fixtures: readonly AdapterFixture[];
  readonly #consumed = new Set<number>();

  constructor(
    fixtures: readonly AdapterFixture[],
    id = "fixture",
  ) {
    if (id.length === 0) {
      throw new TypeError("Adapter id cannot be empty");
    }
    this.id = id;
    this.#fixtures = [...fixtures];
  }

  get remaining(): number {
    return this.#fixtures.reduce(
      (count, fixture, index) =>
        fixture.reusable === true || this.#consumed.has(index)
          ? count
          : count + 1,
      0,
    );
  }

  async complete(
    invocation: AdapterInvocation,
    options: AdapterCallOptions = {},
  ): Promise<AdapterCompletion> {
    if (options.signal?.aborted === true) {
      throw options.signal.reason;
    }
    const index = this.#fixtures.findIndex(
      (fixture, candidateIndex) =>
        (fixture.reusable === true ||
          !this.#consumed.has(candidateIndex)) &&
        fixtureMatches(fixture.match, invocation),
    );
    if (index < 0) {
      throw new AdapterError(
        "AXIP_FIXTURE_MISSING",
        `No fixture matched ${invocation.request.nodeId} (${invocation.requestHash}) attempt ${invocation.attempt}`,
      );
    }

    const fixture = this.#fixtures[index] as AdapterFixture;
    if (fixture.reusable !== true) {
      // Consume before awaiting a dynamic fixture so concurrent invocations
      // cannot claim the same deterministic response.
      this.#consumed.add(index);
    }
    const rawReply =
      typeof fixture.reply === "function"
        ? await fixture.reply(invocation)
        : fixture.reply;
    const text =
      typeof rawReply === "string"
        ? rawReply
        : encodeAxoResponse(rawReply);
    return {
      text,
      adapterId: this.id,
      metadata: { fixture: index },
    };
  }
}

export interface ReplayEntry {
  readonly requestHash: Sha256;
  readonly responseText: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly adapterId?: string;
  readonly model?: string;
  readonly metadata?: JsonObject;
}

export interface ReplayAdapterOptions {
  readonly id?: string;
  /**
   * Strict order detects control-flow divergence. Unordered mode is useful for
   * replaying deterministic parallel branches.
   */
  readonly ordered?: boolean;
}

export function createReplayEntry(
  invocation: AdapterInvocation,
  completion: AdapterCompletion,
): ReplayEntry {
  return {
    requestHash: invocation.requestHash,
    responseText: completion.text,
    runId: invocation.request.runId,
    nodeId: invocation.request.nodeId,
    adapterId: completion.adapterId,
    ...(completion.model === undefined ? {} : { model: completion.model }),
    ...(completion.metadata === undefined
      ? {}
      : { metadata: completion.metadata }),
  };
}

/**
 * Replays recorded model responses by semantic request hash. Inline vs cached
 * prologue transport therefore does not invalidate a recording.
 */
export class ReplayAdapter implements AgentModelAdapter {
  readonly id: string;
  readonly #entries: readonly ReplayEntry[];
  readonly #ordered: boolean;
  readonly #consumed = new Set<number>();
  #cursor = 0;

  constructor(
    entries: readonly ReplayEntry[],
    options: ReplayAdapterOptions = {},
  ) {
    this.id = options.id ?? "replay";
    if (this.id.length === 0) {
      throw new TypeError("Adapter id cannot be empty");
    }
    this.#entries = [...entries];
    this.#ordered = options.ordered ?? true;
  }

  get position(): number {
    return this.#cursor;
  }

  get remaining(): number {
    return this.#entries.length - this.#consumed.size;
  }

  async complete(
    invocation: AdapterInvocation,
    options: AdapterCallOptions = {},
  ): Promise<AdapterCompletion> {
    if (options.signal?.aborted === true) {
      throw options.signal.reason;
    }

    let index: number;
    if (this.#ordered) {
      index = this.#cursor;
      const entry = this.#entries[index];
      if (entry === undefined) {
        throw new ReplayError(
          "AXIP_REPLAY_EXHAUSTED",
          `Replay has no entry for request ${invocation.requestHash}`,
        );
      }
      if (entry.requestHash !== invocation.requestHash) {
        throw new ReplayError(
          "AXIP_REPLAY_DIVERGED",
          `Replay entry ${index} expects ${entry.requestHash}, received ${invocation.requestHash}`,
        );
      }
      this.#cursor += 1;
    } else {
      index = this.#entries.findIndex(
        (entry, candidateIndex) =>
          !this.#consumed.has(candidateIndex) &&
          entry.requestHash === invocation.requestHash,
      );
      if (index < 0) {
        throw new ReplayError(
          "AXIP_REPLAY_MISSING",
          `Replay has no unused entry for request ${invocation.requestHash}`,
        );
      }
    }

    const entry = this.#entries[index] as ReplayEntry;
    this.#consumed.add(index);
    if (
      (entry.runId !== undefined &&
        entry.runId !== invocation.request.runId) ||
      (entry.nodeId !== undefined &&
        entry.nodeId !== invocation.request.nodeId)
    ) {
      throw new ReplayError(
        "AXIP_REPLAY_METADATA",
        `Replay metadata does not match request at entry ${index}`,
      );
    }
    return {
      text: entry.responseText,
      adapterId: this.id,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      metadata: {
        replay_entry: index,
        ...(entry.adapterId === undefined
          ? {}
          : { recorded_adapter: entry.adapterId }),
        ...(entry.metadata ?? {}),
      },
    };
  }
}

export interface HttpRequestParts {
  readonly body: BodyInit;
  readonly headers?: Readonly<Record<string, string>>;
}

export type HttpRequestEncoder = (
  invocation: AdapterInvocation,
) => HttpRequestParts | Promise<HttpRequestParts>;

export type HttpResponseDecoder = (
  response: Response,
  invocation: AdapterInvocation,
) => string | Promise<string>;

export interface HttpTextAdapterOptions {
  readonly endpoint: string | URL;
  readonly id?: string;
  readonly model?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly cachedPrologueRefs?: readonly string[];
  /**
   * Maximum bytes read from the HTTP response body before decoding. Defaults
   * to the inference site's maxOutputBytes. JSON/provider wrappers may set a
   * larger finite cap; the decoded AXO text still obeys maxOutputBytes.
   */
  readonly maxTransportResponseBytes?: number;
  /**
   * Defaults to a text/plain AXIP frame. Supply this to wrap the frame in a
   * provider SDK or JSON HTTP contract without changing VM semantics.
   */
  readonly encodeRequest?: HttpRequestEncoder;
  /**
   * Defaults to response.text(). Supply this for JSON response envelopes.
   */
  readonly decodeResponse?: HttpResponseDecoder;
}

function positiveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  return value;
}

function linkedAbortController(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly controller: AbortController; readonly cleanup: () => void } {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort(external?.reason);
  };
  if (external?.aborted === true) {
    abortFromExternal();
  } else {
    external?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(
            new Error(`HTTP adapter timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
  return {
    controller,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}

async function rejectWhenAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      return true;
    };
    const abort = (): void => {
      if (cleanup()) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("HTTP adapter invocation was aborted"),
        );
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        if (cleanup()) {
          resolve(value);
        }
      },
      (error: unknown) => {
        if (cleanup()) {
          reject(error);
        }
      },
    );
    if (signal.aborted) {
      // The operation handler is already attached, so a concurrently rejected
      // hook or fetch cannot become an unhandled rejection.
      abort();
    }
  });
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/u.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > maximumBytes
    ) {
      await response.body?.cancel();
      throw new AdapterError(
        "AXIP_HTTP_BODY_BUDGET",
        `HTTP response declares ${contentLength} bytes, exceeding transport limit ${maximumBytes}`,
      );
    }
  }

  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AdapterError(
          "AXIP_HTTP_BODY_BUDGET",
          `HTTP response exceeded transport limit ${maximumBytes} bytes`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AdapterError(
      "AXIP_HTTP_UTF8",
      "HTTP response body is not valid UTF-8",
    );
  }
}

function measurableBodyBytes(body: BodyInit): number | undefined {
  if (typeof body === "string") {
    return utf8ByteLength(body);
  }
  if (body instanceof URLSearchParams) {
    return utf8ByteLength(body.toString());
  }
  if (body instanceof Blob) {
    return body.size;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  return undefined;
}

/**
 * Conservative, deterministic accounting for every application-controlled
 * byte passed to fetch: endpoint, merged headers, and body. Wire-protocol
 * overhead inserted by the HTTP stack is intentionally outside this value.
 */
function httpRequestBytes(
  endpoint: string | URL,
  headers: Headers,
  bodyBytes: number,
): number {
  let total = utf8ByteLength(String(endpoint)) + bodyBytes;
  for (const [name, value] of headers.entries()) {
    // Count a stable "name: value\r\n" representation.
    total +=
      utf8ByteLength(name) +
      2 +
      utf8ByteLength(value) +
      2;
    if (!Number.isSafeInteger(total)) {
      throw new AdapterError(
        "AXIP_HTTP_REQUEST_UNBOUNDED",
        "HTTP request byte accounting exceeded the safe-integer range",
      );
    }
  }
  return total;
}

/**
 * Provider-neutral HTTP text transport. By default it POSTs the AXIP frame as
 * text/plain and expects AXO1 text. Hooks can adapt JSON/chat endpoints while
 * preserving the same VM-facing interface.
 */
export class HttpTextAdapter implements AgentModelAdapter {
  readonly id: string;
  readonly model: string | undefined;
  readonly cachedPrologueRefs: readonly string[];
  readonly #endpoint: string | URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #encodeRequest: HttpRequestEncoder | undefined;
  readonly #decodeResponse: HttpResponseDecoder | undefined;
  readonly #maxTransportResponseBytes: number | undefined;

  constructor(options: HttpTextAdapterOptions) {
    this.id = options.id ?? "http-text";
    if (this.id.length === 0) {
      throw new TypeError("Adapter id cannot be empty");
    }
    this.model = options.model;
    this.cachedPrologueRefs = [...(options.cachedPrologueRefs ?? [])];
    this.#endpoint = options.endpoint;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#encodeRequest = options.encodeRequest;
    this.#decodeResponse = options.decodeResponse;
    this.#maxTransportResponseBytes =
      options.maxTransportResponseBytes === undefined
        ? undefined
        : positiveTimeout(options.maxTransportResponseBytes);
    if (typeof this.#fetch !== "function") {
      throw new TypeError("No Fetch API implementation is available");
    }
  }

  async complete(
    invocation: AdapterInvocation,
    options: AdapterCallOptions = {},
  ): Promise<AdapterCompletion> {
    const timeoutMs = positiveTimeout(options.timeoutMs);
    const linked = linkedAbortController(options.signal, timeoutMs);
    try {
      return await rejectWhenAborted(
        (async (): Promise<AdapterCompletion> => {
          const encoded =
            this.#encodeRequest === undefined
              ? {
                  body: invocation.frame,
                  headers: {
                    "content-type": "text/plain; charset=utf-8",
                    accept: "text/plain",
                  },
                }
              : await this.#encodeRequest(invocation);
          const bodyBytes = measurableBodyBytes(encoded.body);
          if (bodyBytes === undefined) {
            throw new AdapterError(
              "AXIP_HTTP_REQUEST_BODY_UNBOUNDED",
              "HTTP request body must have a measurable finite byte length",
            );
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(this.#headers)) {
            headers.set(name, value);
          }
          for (const [name, value] of Object.entries(encoded.headers ?? {})) {
            headers.set(name, value);
          }
          const requestBytes = httpRequestBytes(
            this.#endpoint,
            headers,
            bodyBytes,
          );
          if (requestBytes > invocation.request.budget.maxInputBytes) {
            throw new AdapterError(
              "AXIP_HTTP_REQUEST_BUDGET",
              `HTTP request material is ${requestBytes} bytes, exceeding maxInputBytes ${invocation.request.budget.maxInputBytes}`,
            );
          }
          const response = await this.#fetch(this.#endpoint, {
            method: "POST",
            headers,
            body: encoded.body,
            signal: linked.controller.signal,
          });
          const transportLimit =
            this.#maxTransportResponseBytes ??
            invocation.request.budget.maxOutputBytes;
          if (!response.ok) {
            let detail = "";
            try {
              detail = await readBoundedResponseText(
                response,
                Math.min(4_096, transportLimit),
              );
            } catch (error) {
              if (
                error instanceof AdapterError &&
                error.code === "AXIP_HTTP_BODY_BUDGET"
              ) {
                detail = "[response body exceeded diagnostic byte limit]";
              } else {
                throw error;
              }
            }
            throw new AdapterError(
              "AXIP_HTTP_STATUS",
              `HTTP ${response.status} ${response.statusText}${
                detail.length === 0 ? "" : `: ${detail}`
              }`,
            );
          }
          const bodyText = await readBoundedResponseText(
            response,
            transportLimit,
          );
          const text =
            this.#decodeResponse === undefined
              ? bodyText
              : await this.#decodeResponse(
                  new Response(bodyText, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                  }),
                  invocation,
                );
          if (typeof text !== "string") {
            throw new AdapterError(
              "AXIP_HTTP_TEXT",
              "HTTP response decoder did not return text",
            );
          }
          return {
            text,
            adapterId: this.id,
            ...(this.model === undefined ? {} : { model: this.model }),
            metadata: {
              http_status: response.status,
              ...(response.headers.get("content-type") === null
                ? {}
                : {
                    content_type: response.headers.get(
                      "content-type",
                    ) as string,
                  }),
            },
          };
        })(),
        linked.controller.signal,
      );
    } catch (error) {
      if (error instanceof AdapterError) {
        throw error;
      }
      throw new AdapterError(
        "AXIP_HTTP",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      linked.cleanup();
    }
  }
}

/**
 * Utility for JSON HTTP endpoints whose response envelope contains AXO1 text.
 */
export function jsonTextEnvelopeDecoder(
  field = "text",
): HttpResponseDecoder {
  return async (response): Promise<string> => {
    const value = (await response.json()) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>)[field] !== "string"
    ) {
      throw new AdapterError(
        "AXIP_HTTP_ENVELOPE",
        `Expected JSON response field ${JSON.stringify(field)} containing text`,
      );
    }
    return (value as Record<string, string>)[field] as string;
  };
}

/**
 * Utility for wrapping AXIP text in a small JSON request body.
 */
export function jsonTextEnvelopeEncoder(
  field = "input",
  extra: Readonly<Record<string, JsonValue>> = {},
): HttpRequestEncoder {
  return (invocation): HttpRequestParts => ({
    body: JSON.stringify({ ...extra, [field]: invocation.frame }),
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
  });
}
