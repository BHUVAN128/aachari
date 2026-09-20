import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProviderError } from "@upcraft/providers";

/**
 * Gap 4 — transport hardening (test-local first; promoted at Phase 6).
 *
 * Provider fetches currently have no abort signal in `openai.ts`/`gemini.ts`/
 * `elevenlabs.ts`, and a terminated body or a hung socket surfaces as an opaque
 * `SyntaxError`/hang rather than a classified, retryable transport failure. This
 * module defines the typed transport error, a timeout-bound fetch, and a bounded
 * retry that only retries classified transient transport failures. Promotion
 * moves the timeout signal and classification into `packages/providers`.
 *
 * Timeout budget mirrors the plan: 120s planning / 60s verifier / 300s TTS+image.
 */
export const TRANSPORT_TIMEOUTS_MS = {
  planning: 120_000,
  verifier: 60_000,
  media: 300_000,
} as const;

export type TransportFailure = "timeout" | "abort" | "truncated" | "network";
export const TRANSPORT_TRUNCATED = "TRANSPORT_TRUNCATED";

/**
 * A classified transport failure is retryable and, because it extends
 * `ProviderError`, it flows through the existing `withFallback` route unchanged —
 * so a truncation or timeout on the primary route can use the declared fallback.
 */
export class TransportError extends ProviderError {
  public readonly failure: TransportFailure;

  public constructor(failure: TransportFailure, message: string) {
    super(message, { code: failure === "truncated" ? TRANSPORT_TRUNCATED : `TRANSPORT_${failure.toUpperCase()}`, retryable: true });
    this.name = "TransportError";
    this.failure = failure;
  }
}

/** Flattens an error and its `cause` chain into name/message/code signals. */
const errorChain = (error: unknown): Array<{ name: string; message: string; code: string }> => {
  const chain: Array<{ name: string; message: string; code: string }> = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      const cause = (current as { cause?: unknown }).cause;
      const code = (current as unknown as { code?: unknown }).code;
      chain.push({ name: current.name, message: current.message, code: typeof code === "string" ? code : "" });
      current = cause;
    } else {
      chain.push({ name: "", message: String(current), code: "" });
      break;
    }
  }
  return chain;
};

/** Classifies a thrown fetch/parse failure as a retryable transport error. */
export const classifyTransportError = (error: unknown): TransportError => {
  if (error instanceof TransportError) return error;
  const chain = errorChain(error);
  const combined = chain.map((link) => `${link.name} ${link.message} ${link.code}`).join(" | ");
  if (chain.some((link) => link.name === "TimeoutError") || /timed out|timeout/i.test(combined)) return new TransportError("timeout", `Transport timed out: ${combined}`);
  if (chain.some((link) => link.name === "AbortError") || /aborted/i.test(combined)) return new TransportError("abort", `Transport aborted: ${combined}`);
  if (/terminated|truncated|premature|unexpected end|incomplete|other side closed|UND_ERR_SOCKET/i.test(combined)) return new TransportError("truncated", `Transport truncated: ${combined}`);
  return new TransportError("network", `Transport failed: ${combined}`);
};

/**
 * `fetch` with an abort timeout. A timeout, abort, or truncated body is converted
 * into a classified `TransportError` so callers can retry it as transient instead
 * of surfacing a raw `SyntaxError`.
 */
export const fetchWithTimeout = async (input: string | URL, init: RequestInit & { timeoutMs: number }): Promise<Response> => {
  const { timeoutMs, ...rest } = init;
  try {
    const response = await fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (response.body && Number.isFinite(declared)) {
      const [original, probe] = response.body.tee();
      const bytes = await readAll(probe);
      if (bytes.byteLength !== declared) throw new TransportError("truncated", `Body truncated: expected ${declared} bytes, received ${bytes.byteLength}`);
      return new Response(original, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  } catch (error) {
    throw classifyTransportError(error);
  }
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

export type RetryAttempt = { attempt: number; outcome: "completed" | "transport-truncated" | "transport-timeout" | "transport-abort"; errorCode: string | null };

/**
 * Bounded retry for classified transport failures only. Non-transport errors are
 * rethrown immediately so a permanent failure is never retried as transient.
 */
export const withTransportRetry = async <T>(params: {
  maxAttempts?: number;
  attempt: () => Promise<T>;
  onAttempt?: (record: RetryAttempt) => Promise<void> | void;
}): Promise<T> => {
  const maxAttempts = params.maxAttempts ?? 3;
  let lastError: TransportError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await params.attempt();
      await params.onAttempt?.({ attempt, outcome: "completed", errorCode: null });
      return value;
    } catch (error) {
      const classified = classifyTransportError(error);
      lastError = classified;
      await params.onAttempt?.({ attempt, outcome: classified.failure === "truncated" ? "transport-truncated" : `transport-${classified.failure}` as RetryAttempt["outcome"], errorCode: classified.code });
    }
  }
  throw lastError ?? new TransportError("network", "Transport retry exhausted without an error");
};

/**
 * A local flaky HTTP server used to exercise the real transport code path:
 *   - `failFirst`: truncate the body of the first N responses, then succeed
 *   - `hangFirst`: never respond to the first N requests (forces a timeout)
 */
export const startFlakyServer = async (options: { failFirst?: number; hangFirst?: number; body?: string }): Promise<{ url: string; close: () => Promise<void>; requests: () => number }> => {
  const body = options.body ?? JSON.stringify({ ok: true });
  let requests = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests += 1;
    const index = requests;
    if (options.hangFirst && index <= options.hangFirst) return;
    if (options.failFirst && index <= options.failFirst) {
      response.writeHead(200, { "content-type": "application/json", "content-length": String(body.length + 50) });
      response.write(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests: () => requests,
    // Hung sockets would otherwise keep `close` waiting until the OS timeout.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};