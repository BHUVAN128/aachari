import { ZodError } from "zod";

/**
 * Classified intake retry policy with backoff (Point 7b, promoted).
 *
 * Replaces the hardcoded `attempt < 3` and the immediate re-queue with a bounded,
 * classified policy: 429/timeout get a longer jittered window, 5xx/network a
 * shorter one, and authentication/quota/validation/safety failures never retry.
 * Mirrors the shape of `retry-policy.ts` so the two read alike.
 */

export const MAX_INTAKE_ATTEMPTS = 3;
export const INTAKE_RATE_LIMIT_BASE_MS = 2_000;
export const INTAKE_SERVER_ERROR_BASE_MS = 500;
export const INTAKE_MAX_RETRY_DELAY_MS = 30_000;
export const INTAKE_JITTER_RATIO = 0.25;

export type IntakeFailureClass = "rate_limit" | "server_error" | "timeout" | "network" | "authentication" | "quota" | "validation" | "safety" | "permanent";

const TRANSIENT_CLASSES: readonly IntakeFailureClass[] = ["rate_limit", "server_error", "timeout", "network"];
const SAFETY_REJECTION_CODES = ["safety_policy_rejected", "safety_review_required"];
const NETWORK_CODES = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"];

const baseDelayFor = (failureClass: IntakeFailureClass) =>
  failureClass === "rate_limit" || failureClass === "timeout" ? INTAKE_RATE_LIMIT_BASE_MS : INTAKE_SERVER_ERROR_BASE_MS;

const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { statusCode?: number; status?: number };
  const status = candidate.statusCode ?? candidate.status;
  return typeof status === "number" ? status : undefined;
};

const codeOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code : undefined;
};

const failureCodeOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { failureCode?: unknown };
  return typeof candidate.failureCode === "string" ? candidate.failureCode : undefined;
};

/** Classifies a failure into a bounded, retryable-or-terminal bucket. */
export const classifyIntakeFailure = (error: unknown): IntakeFailureClass => {
  if (SAFETY_REJECTION_CODES.includes(failureCodeOf(error) ?? "")) return "safety";
  if (error instanceof ZodError || error instanceof SyntaxError) return "validation";
  const status = statusOf(error);
  const code = codeOf(error);
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (typeof status === "number" && status >= 500) return "server_error";
  if (code && NETWORK_CODES.includes(code)) return "network";
  return "permanent";
};

/** Exponential backoff with bounded, deterministic-when-injected jitter. */
export const nextRetryDelayMs = (params: { attemptCount: number; failureClass: IntakeFailureClass; random?: () => number }): number => {
  const random = params.random ?? Math.random;
  const attempt = Math.max(1, params.attemptCount);
  const exponential = baseDelayFor(params.failureClass) * 2 ** (attempt - 1);
  const jitter = 1 + (random() * 2 - 1) * INTAKE_JITTER_RATIO;
  return Math.min(INTAKE_MAX_RETRY_DELAY_MS, Math.max(0, Math.round(exponential * jitter)));
};

export type IntakeRetryDecision =
  | { retry: true; delayMs: number; failureClass: IntakeFailureClass; reason: "retryable_transient_failure" }
  | { retry: false; delayMs: null; failureClass: IntakeFailureClass; reason: "attempt_budget_exhausted" | "not_retryable_failure" };

/** Budget is checked first so a transient failure at the ceiling is never re-queued. */
export const decideIntakeRetry = (params: { attemptCount: number; error: unknown; random?: () => number }): IntakeRetryDecision => {
  const failureClass = classifyIntakeFailure(params.error);
  if (params.attemptCount >= MAX_INTAKE_ATTEMPTS) return { retry: false, delayMs: null, failureClass, reason: "attempt_budget_exhausted" };
  if (!TRANSIENT_CLASSES.includes(failureClass)) return { retry: false, delayMs: null, failureClass, reason: "not_retryable_failure" };
  return { retry: true, delayMs: nextRetryDelayMs({ attemptCount: params.attemptCount, failureClass, ...(params.random ? { random: params.random } : {}) }), failureClass, reason: "retryable_transient_failure" };
};
