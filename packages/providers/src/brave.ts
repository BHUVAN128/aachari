import type { ModelRoute } from "@upcraft/contracts";
import { ProviderError } from "./errors.ts";
import { BraveMcpClient, type BraveMcpClientOptions } from "./brave-mcp.ts";

/**
 * Brave LLM Context retrieval with a bounded, escalating-timeout ladder.
 *
 * The ladder keeps the mandated five attempts while bounding worst-case user
 * latency: 10/15/20/35/40 s plus jittered backoff of 1/2/4/8 s (~135 s worst
 * case), leaving headroom for segmentation, planning, and artifact saves. The
 * threshold is relaxed from precision (`strict`) to recall (`disabled`) and the
 * final attempt broadens the query to topic keywords only.
 *
 * Auth/quota failures are terminal (`BraveTerminalError`) and are never retried;
 * everything else is retried. Every attempt — success or failure — is reported to
 * the caller through `onAttempt` so the provider ledger accounts for all of them.
 */

export type BraveContextThresholdMode = "disabled" | "strict" | "lenient" | "balanced";

export type BraveLlmContextParams = {
  query: string;
  count?: number;
  maximum_number_of_tokens?: number;
  maximum_number_of_tokens_per_url?: number;
  maximum_number_of_snippets?: number;
  context_threshold_mode?: BraveContextThresholdMode;
  country?: string;
  search_lang?: string;
  safesearch?: "off" | "moderate" | "strict";
  freshness?: string;
  goggles?: string;
};

export type BraveLadderStep = {
  attempt: number;
  timeoutMs: number;
  params: Omit<BraveLlmContextParams, "query">;
  broaden?: boolean;
};

/** Five attempts, precision-first, ceiling-compressed. */
export const BRAVE_RETRY_LADDER: readonly BraveLadderStep[] = [
  { attempt: 1, timeoutMs: 10_000, params: { count: 5, maximum_number_of_tokens: 8192, context_threshold_mode: "strict" } },
  { attempt: 2, timeoutMs: 15_000, params: { context_threshold_mode: "balanced" } },
  { attempt: 3, timeoutMs: 20_000, params: { context_threshold_mode: "lenient" } },
  { attempt: 4, timeoutMs: 35_000, params: { count: 8, context_threshold_mode: "disabled" } },
  { attempt: 5, timeoutMs: 40_000, params: { count: 8, maximum_number_of_tokens: 16384, context_threshold_mode: "disabled" }, broaden: true },
];

/** Backoff before attempts 2..5; jittered unless a deterministic jitter is injected. */
export const BRAVE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

export type BraveGroundingSource = { url: string; title: string; snippets: string[] };

export type BraveAttemptRecord = {
  attempt: number;
  timeoutMs: number;
  thresholdMode: BraveContextThresholdMode | null;
  count: number | null;
  maximumTokens: number | null;
  broadened: boolean;
  outcome: "completed" | "failed";
  errorCode: string | null;
  sourceCount: number;
  latencyMs: number;
};

/** All five attempts failed (terminal early or exhaustion). Message is client-safe. */
export class BraveResearchUnavailableError extends ProviderError {
  public readonly attempts: BraveAttemptRecord[];

  public constructor(code: string, attempts: BraveAttemptRecord[]) {
    super("Something went wrong. Please try again later.", { code, retryable: false });
    this.name = "BraveResearchUnavailableError";
    this.attempts = attempts;
  }
}

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "does", "do", "for", "from", "how", "in", "into", "is", "it", "of", "on", "or", "please", "that", "the", "their", "there", "these", "this", "to", "using", "what", "when", "where", "which", "why", "with", "work", "works", "explain", "explained", "about"]);

/** Last-resort widening: strip punctuation and stopwords, keep up to 10 topic keywords. */
export const broadenQuery = (query: string): string => {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 10).join(" ") || query.trim();
};

/**
 * Parses `grounding.generic[]` ({ url, title, snippets[] }) plus the `sources`
 * map into per-URL sources. `grounding.poi`/`grounding.map` are local recall and
 * are intentionally ignored. Malformed entries are dropped, never trusted.
 */
export const parseBraveGrounding = (payload: unknown): BraveGroundingSource[] => {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { grounding?: unknown; sources?: unknown };
  const grounding = record.grounding && typeof record.grounding === "object" ? (record.grounding as { generic?: unknown }) : undefined;
  const generic = Array.isArray(grounding?.generic) ? grounding.generic : [];
  const sourcesMap = record.sources && typeof record.sources === "object" && !Array.isArray(record.sources) ? (record.sources as Record<string, { title?: unknown; snippets?: unknown }>) : {};

  return generic.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { url, title, snippets } = entry as { url?: unknown; title?: unknown; snippets?: unknown };
    if (typeof url !== "string" || !url.trim()) return [];
    const mapped = sourcesMap[url];
    const resolvedTitle = typeof title === "string" && title.trim() ? title : typeof mapped?.title === "string" ? mapped.title : url;
    const rawSnippets = Array.isArray(snippets) ? snippets : Array.isArray(mapped?.snippets) ? mapped!.snippets : [];
    const resolvedSnippets = rawSnippets.filter((snippet): snippet is string => typeof snippet === "string" && snippet.trim().length > 0);
    return [{ url, title: resolvedTitle, snippets: resolvedSnippets }];
  });
};

const hasGrounding = (source: BraveGroundingSource): boolean => source.snippets.some((snippet) => snippet.trim().length > 0);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultJitter = (baseMs: number) => baseMs + Math.floor(Math.random() * (baseMs / 4));

export type BraveResearchOptions = {
  query: string;
  /** Inject a preconfigured client (tests pass a fake-server command). */
  client?: BraveMcpClient;
  clientFactory?: () => BraveMcpClient;
  clientOptions?: BraveMcpClientOptions;
  sleep?: (ms: number) => Promise<void>;
  jitter?: (baseMs: number) => number;
  now?: () => number;
  onAttempt?: (record: BraveAttemptRecord) => void | Promise<void>;
};

export type BraveResearchResult = {
  schemaVersion: "research-web/v1";
  query: string;
  sources: BraveGroundingSource[];
  attempts: BraveAttemptRecord[];
};

const classifyBraveError = (error: unknown): { retryable: boolean; code: string } => {
  if (error instanceof ProviderError) return { retryable: error.retryable, code: error.code };
  return { retryable: true, code: "BRAVE_UNKNOWN" };
};

const recordOf = (step: BraveLadderStep, broadened: boolean, outcome: BraveAttemptRecord["outcome"], errorCode: string | null, sourceCount: number, latencyMs: number): BraveAttemptRecord => ({
  attempt: step.attempt,
  timeoutMs: step.timeoutMs,
  thresholdMode: step.params.context_threshold_mode ?? null,
  count: step.params.count ?? null,
  maximumTokens: step.params.maximum_number_of_tokens ?? null,
  broadened,
  outcome,
  errorCode,
  sourceCount,
  latencyMs,
});

/**
 * Runs the ladder end to end. The client is started and the pinned tool schema
 * asserted once; then each attempt may report an attempt record. On the first
 * attempt with usable grounding it returns; terminal failures and exhaustion
 * throw `BraveResearchUnavailableError` carrying every attempt record.
 */
export const runBraveResearch = async (route: ModelRoute, options: BraveResearchOptions): Promise<BraveResearchResult> => {
  void route;
  const client = options.client ?? (options.clientFactory ? options.clientFactory() : new BraveMcpClient(options.clientOptions));
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? defaultJitter;
  const now = options.now ?? Date.now;
  const attempts: BraveAttemptRecord[] = [];
  let lastCode = "BRAVE_EXHAUSTED";

  try {
    await client.start();
    await client.assertLlmContextTool();
    for (const step of BRAVE_RETRY_LADDER) {
      if (step.attempt > 1) await sleep(jitter(BRAVE_BACKOFF_MS[step.attempt - 2] ?? 0));
      const broadened = step.broaden === true;
      const query = broadened ? broadenQuery(options.query) : options.query;
      const started = now();
      try {
        const { payload } = await client.callLlmContext({ query, ...step.params }, step.timeoutMs);
        const sources = parseBraveGrounding(payload).filter(hasGrounding);
        if (sources.length) {
          const record = recordOf(step, broadened, "completed", null, sources.length, now() - started);
          attempts.push(record);
          await options.onAttempt?.(record);
          return { schemaVersion: "research-web/v1", query, sources, attempts };
        }
        const record = recordOf(step, broadened, "failed", "BRAVE_EMPTY_GROUNDING", 0, now() - started);
        attempts.push(record);
        await options.onAttempt?.(record);
      } catch (error) {
        const classified = classifyBraveError(error);
        lastCode = classified.code;
        const record = recordOf(step, broadened, "failed", classified.code, 0, now() - started);
        attempts.push(record);
        await options.onAttempt?.(record);
        if (!classified.retryable) throw new BraveResearchUnavailableError(classified.code, attempts);
      }
    }
    throw new BraveResearchUnavailableError(lastCode === "BRAVE_EXHAUSTED" ? "BRAVE_EXHAUSTED" : lastCode, attempts);
  } finally {
    await client.close().catch(() => undefined);
  }
};
