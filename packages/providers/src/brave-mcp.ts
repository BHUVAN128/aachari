import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProviderError } from "./errors.ts";

/**
 * Dependency-free MCP stdio client for the official Brave Search MCP server.
 *
 * Evidence basis (v2.1.4, main): the server registers `brave_llm_context` with
 * `inputSchema = LlmContextInputSchema` (RequestParams + RequestHeaders), which
 * explicitly includes `count`, `maximum_number_of_tokens`,
 * `maximum_number_of_tokens_per_url`, `maximum_number_of_snippets`, and
 * `context_threshold_mode`. It passes every defined parameter through to the API.
 *
 * Two hazards are handled here rather than by forking the server:
 *   1. Version drift — a future release could narrow the schema, and zod strips
 *      unknown keys silently, turning the threshold ladder into a no-op. The
 *      client pins the server version and asserts the required LLM-context
 *      parameters exist in `tools/list` before any request; a mismatch fails
 *      loudly (non-retryable) instead of silently degrading.
 *   2. Invisible HTTP status — the server throws
 *      `new Error(`${status} ${statusText}\n${body}`)` so the numeric status is
 *      embedded at the start of the flattened tool result. The client never sees
 *      an HTTP status and therefore classifies auth/quota failures from the
 *      flattened tool text.
 *
 * The transport speaks newline-delimited JSON-RPC 2.0 over the child's stdio,
 * which is what the official TypeScript MCP SDK uses.
 */

export const BRAVE_MCP_SERVER_PACKAGE = "@brave/brave-search-mcp-server";
export const BRAVE_MCP_SERVER_VERSION = "2.1.4";
export const BRAVE_MCP_DEFAULT_COMMAND = "npx";
export const BRAVE_MCP_DEFAULT_ARGS = ["-y", `${BRAVE_MCP_SERVER_PACKAGE}@${BRAVE_MCP_SERVER_VERSION}`, "--transport", "stdio"];
export const BRAVE_LLM_CONTEXT_TOOL = "brave_llm_context";
/** Parameters the ladder depends on; asserted present at init. */
export const BRAVE_REQUIRED_SCHEMA_KEYS = ["count", "maximum_number_of_tokens", "context_threshold_mode"] as const;
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** A transport failure that is safe to retry (timeout, truncated stream, child exit after init). */
export class McpTransportError extends ProviderError {
  public readonly failure: "timeout" | "child-exit" | "transport";

  public constructor(failure: "timeout" | "child-exit" | "transport", message: string, code?: string) {
    super(message, { code: code ?? (failure === "timeout" ? "BRAVE_TIMEOUT" : failure === "child-exit" ? "BRAVE_CHILD_EXIT" : "BRAVE_TRANSPORT"), retryable: true });
    this.name = "McpTransportError";
    this.failure = failure;
  }
}

/** The child died before initializing (missing key, npx failure). Never retried; the run is visibly blocked. */
export class BraveCredentialError extends ProviderError {
  public constructor(message: string) {
    super(message, { code: "BRAVE_CREDENTIALS", retryable: false });
    this.name = "BraveCredentialError";
  }
}

/** The pinned server no longer declares a parameter the ladder needs. Never retried. */
export class BraveSchemaDriftError extends ProviderError {
  public constructor(message: string) {
    super(message, { code: "BRAVE_SCHEMA_DRIFT", retryable: false });
    this.name = "BraveSchemaDriftError";
  }
}

/** A classified terminal tool error (401/403/402, invalid key, quota exceeded). Never retried. */
export class BraveTerminalError extends ProviderError {
  public constructor(message: string, code: string) {
    super(message, { code, retryable: false });
    this.name = "BraveTerminalError";
  }
}

export type BraveFailureClass = { retryable: boolean; code: string; kind: "terminal" | "rate-limit" | "server" | "malformed" };

/**
 * Terminal patterns. Order matters: auth/quota are checked before retryable
 * patterns so a body such as `401 Unauthorized` can never be read as transient.
 * Matches the governing gate that auth/quota do not retry.
 */
const TERMINAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b401\b/, "BRAVE_401"],
  [/\b402\b/, "BRAVE_402"],
  [/\b403\b/, "BRAVE_403"],
  [/unauthorized/i, "BRAVE_UNAUTHORIZED"],
  [/forbidden/i, "BRAVE_FORBIDDEN"],
  [/invalid\s+api[\s_-]?key/i, "BRAVE_INVALID_API_KEY"],
  [/api[\s_-]?key\s+(is\s+)?(missing|invalid|required)/i, "BRAVE_INVALID_API_KEY"],
  [/quota\s+exceeded/i, "BRAVE_QUOTA_EXCEEDED"],
  [/payment\s+required/i, "BRAVE_PAYMENT_REQUIRED"],
  [/insufficient\s+(funds|credits?)/i, "BRAVE_PAYMENT_REQUIRED"],
];

/** Transient patterns. Everything unmatched is treated as retryable malformed/transport. */
const RETRYABLE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b429\b/, "BRAVE_429"],
  [/rate[\s_-]?limit/i, "BRAVE_RATE_LIMIT"],
  [/too\s+many\s+requests/i, "BRAVE_RATE_LIMIT"],
  [/\b5\d\d\b/, "BRAVE_5XX"],
  [/internal\s+server\s+error/i, "BRAVE_500"],
  [/bad\s+gateway/i, "BRAVE_502"],
  [/service\s+unavailable/i, "BRAVE_503"],
  [/gateway\s+timeout/i, "BRAVE_504"],
];

/** Classifies flattened tool-error text (status code embedded at the start of the message). */
export const classifyBraveFailureText = (raw: string): BraveFailureClass => {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  for (const [pattern, code] of TERMINAL_PATTERNS) if (pattern.test(text)) return { retryable: false, code, kind: "terminal" };
  for (const [pattern, code] of RETRYABLE_PATTERNS) {
    if (pattern.test(text)) return { retryable: true, code, kind: code === "BRAVE_429" || code === "BRAVE_RATE_LIMIT" ? "rate-limit" : "server" };
  }
  return { retryable: true, code: "BRAVE_MALFORMED", kind: "malformed" };
};

/** Flattens a tool result (content parts + structuredContent + message) into the text used for classification. */
export const flattenToolError = (result: unknown): string => {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { content?: unknown; structuredContent?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") parts.push((part as { text: string }).text);
    }
  }
  if (record.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(record.structuredContent));
    } catch {
      /* non-serializable structured content is ignored for classification */
    }
  }
  if (typeof record.message === "string") parts.push(record.message);
  return parts.join("\n");
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type RpcEnvelope = { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export type BraveMcpClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  startupTimeoutMs?: number;
};

const toolText = (result: { content?: unknown } | undefined): string => {
  if (!result || !Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const part of result.content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") parts.push((part as { text: string }).text);
  }
  return parts.join("\n");
};

/** Parses the structured grounding payload, falling back to the JSON in `content[0].text`. */
export const parseToolPayload = (result: unknown): Record<string, unknown> => {
  if (!result || typeof result !== "object") return {};
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === "object") return structured as Record<string, unknown>;
  const text = toolText(result as { content?: unknown });
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export class BraveMcpClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string | undefined;
  private readonly startupTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private started = false;
  private exited = false;
  private exitError: Error | null = null;

  public constructor(options: BraveMcpClientOptions = {}) {
    this.command = options.command ?? process.env.BRAVE_MCP_COMMAND?.trim() ?? BRAVE_MCP_DEFAULT_COMMAND;
    const envArgs = process.env.BRAVE_MCP_ARGS?.trim();
    this.args = options.args ?? (envArgs ? envArgs.split(/\s+/).filter(Boolean) : [...BRAVE_MCP_DEFAULT_ARGS]);
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  }

  /** Spawns the child, performs the MCP handshake, and marks the client initialized. */
  public async start(): Promise<void> {
    if (this.child) return;
    this.exited = false;
    this.exitError = null;
    this.buffer = "";
    const child = spawn(this.command, this.args, { env: { ...this.env }, ...(this.cwd ? { cwd: this.cwd } : {}), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on("error", (error) => this.failAll(new McpTransportError("transport", `Brave MCP process error: ${error.message}`)));
    child.on("exit", (code, signal) => this.onExit(code, signal));

    await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "upcraft-pipeline", version: "1.0.0" } }, this.startupTimeoutMs);
    this.started = true;
    this.notify("notifications/initialized", {});
  }

  /**
   * Asserts that the pinned server still declares the LLM-context parameters the
   * threshold ladder relies on. A mismatch is non-retryable and visibly blocks.
   */
  public async assertLlmContextTool(timeoutMs = 15_000): Promise<string[]> {
    const result = (await this.request("tools/list", {}, timeoutMs)) as { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const tool = tools.find((candidate) => candidate?.name === BRAVE_LLM_CONTEXT_TOOL);
    if (!tool) throw new BraveSchemaDriftError(`Brave MCP server does not expose the ${BRAVE_LLM_CONTEXT_TOOL} tool`);
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    const missing = BRAVE_REQUIRED_SCHEMA_KEYS.filter((key) => !properties.includes(key));
    if (missing.length) throw new BraveSchemaDriftError(`Brave ${BRAVE_LLM_CONTEXT_TOOL} schema is missing required parameters: ${missing.join(", ")}`);
    return properties;
  }

  /**
   * Calls `brave_llm_context`. A tool error is classified from its flattened text:
   * terminal auth/quota throw a non-retryable `BraveTerminalError`, everything
   * else throws a retryable `McpTransportError` so the ladder can back off.
   */
  public async callLlmContext(params: Record<string, unknown>, timeoutMs: number): Promise<{ payload: Record<string, unknown>; text: string }> {
    const result = (await this.request("tools/call", { name: BRAVE_LLM_CONTEXT_TOOL, arguments: params }, timeoutMs)) as { content?: unknown; isError?: boolean } | undefined;
    const text = toolText(result);
    if (result?.isError === true) {
      const failure = classifyBraveFailureText(flattenToolError(result));
      const message = `Brave tool error (${failure.code}): ${text.slice(0, 300)}`;
      if (failure.retryable) throw new McpTransportError("transport", message, failure.code);
      throw new BraveTerminalError(message, failure.code);
    }
    return { payload: parseToolPayload(result), text };
  }

  /** Terminates the child and rejects any in-flight request. Safe to call repeatedly. */
  public async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpTransportError("transport", "Brave MCP client closed"));
    }
    this.pending.clear();
    if (child.exitCode === null && !child.killed) {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.consume(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private consume(line: string): void {
    let message: RpcEnvelope;
    try {
      message = JSON.parse(line) as RpcEnvelope;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new McpTransportError("transport", `Brave MCP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`));
    else pending.resolve(message.result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.exited) return Promise.reject(this.exitError ?? new McpTransportError("transport", "Brave MCP client is not running"));
    const child = this.child;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTransportError("timeout", `Brave MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpTransportError("transport", `Brave MCP write failed: ${error.message}`));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    const detail = this.stderrTail.trim() || `exit code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
    const error = this.started
      ? new McpTransportError("child-exit", `Brave MCP server exited (${detail})`)
      : new BraveCredentialError(`Brave MCP server exited before initialization: ${detail}`);
    this.failAll(error);
  }

  private failAll(error: Error): void {
    if (this.pending.size) this.exitError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
