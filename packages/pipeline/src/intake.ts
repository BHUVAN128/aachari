import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import { IntakeSessionInputSchema, type IntakeSessionInput } from "@upcraft/contracts";
import { getDb, intakeAttempts, intakeSessions } from "@upcraft/db";
import {
  classifyRequestSafety,
  decideSafetyGate,
  isSafetyFailureCode,
  keywordSafetyClassifier,
  PRICING_VERSION,
  resolveModelRoute,
  SAFETY_AGENT_ID,
  SAFETY_PROMPT_VERSION,
  estimateCostMicrounits,
  type ProviderUsageSnapshot,
  type SafetyClassification,
} from "@upcraft/providers";
import { assertIntakeCapabilities, generateIntakeBrief, INTAKE_AGENT_ID, INTAKE_PROMPT_VERSION } from "@upcraft/providers/intake";
import { createVideoRun } from "./runs.ts";
import { enqueueIntakeSession } from "./queue.ts";
import { scheduleIntakeSession } from "./outbox.ts";
import { intakeContextManifest, projectIntakeContext } from "./intake-projection.ts";
import { normalizeIntakeBrief } from "./intake-normalize.ts";
import { validateDomainClassification } from "./domain-routing.ts";
import { classifyIntakeFailure, decideIntakeRetry } from "./pipeline/intake-retry.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeMessage = (error: unknown) => (error instanceof Error ? error.message.slice(0, 500) : "Intake briefing failed.");

/** Injectable model classifier so tests can run without a provider call. */
export type SafetyClassifierFn = (requestText: string) => Promise<SafetyClassification>;

export const createIntakeSession = async (rawInput: IntakeSessionInput, sessionId = randomUUID()) => {
  const input = IntakeSessionInputSchema.parse(rawInput);
  const db = getDb();
  await db.insert(intakeSessions).values({ id: sessionId, input, inputHash: hash(input), status: "queued" });
  await scheduleIntakeSession(sessionId);
  return sessionId;
};

type SafetyGateResult = {
  allowed: boolean;
  failureCode: string | null;
  classification: SafetyClassification;
  modelCalled: boolean;
  usage?: ProviderUsageSnapshot;
};

/**
 * Deterministic pre-filter (zero tokens, may only reject) followed by the
 * approved model safety-classification route. A classifier infrastructure error
 * propagates and is retried as a normal transient failure.
 */
const runSafetyGate = async (requestText: string, classify?: SafetyClassifierFn): Promise<SafetyGateResult> => {
  const deterministic = keywordSafetyClassifier(requestText);
  if (deterministic.label !== "safe") return { ...decideSafetyGate(deterministic), classification: deterministic, modelCalled: false };
  if (classify) {
    const classification = await classify(requestText);
    return { ...decideSafetyGate(classification), classification, modelCalled: true };
  }
  const result = await classifyRequestSafety({ requestText });
  return { ...decideSafetyGate(result.value), classification: result.value, modelCalled: true, usage: result.usage };
};

/**
 * Persists one provider attempt with pricing version always stamped and cost from
 * the shared pricing math; an unpriced route records `costMicrounits: null`
 * explicitly rather than silently.
 */
const recordAttempt = async (params: {
  sessionId: string;
  attempt: number;
  provider: string;
  model: string;
  promptVersion: string;
  outcome: "completed" | "failed";
  latencyMs: number;
  error?: unknown;
  usage?: ProviderUsageSnapshot | undefined;
  contextManifest: Record<string, unknown>;
}) => {
  const db = getDb();
  const usage = params.usage ?? {};
  const route = params.promptVersion === SAFETY_PROMPT_VERSION ? resolveModelRoute("safety-classification") : resolveModelRoute("intake-brief");
  const errorCode = params.error && typeof params.error === "object" && "code" in params.error ? String((params.error as { code?: unknown }).code) : undefined;
  const cost = estimateCostMicrounits(route.provider, usage);
  await db.insert(intakeAttempts).values({
    sessionId: params.sessionId,
    attempt: params.attempt,
    provider: route.provider,
    model: usage.model ?? params.model,
    requestId: usage.requestId,
    promptVersion: params.promptVersion,
    outcome: params.outcome,
    errorCode,
    errorMessage: params.error ? safeMessage(params.error) : null,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    inputCharacters: usage.inputCharacters,
    outputCharacters: usage.outputCharacters,
    costMicrounits: cost ?? null,
    pricingVersion: route.pricingVersion ?? PRICING_VERSION,
    contextManifest: params.contextManifest,
    latencyMs: params.latencyMs,
  }).onConflictDoNothing();
};

/** Schedules a bounded, classified retry; returns false when the run is terminal. */
const scheduleRetry = async (sessionId: string, attempt: number, error: unknown, failureCode: string) => {
  const decision = decideIntakeRetry({ attemptCount: attempt, error });
  const db = getDb();
  if (!decision.retry) {
    await db.update(intakeSessions).set({ status: "failed", failureCode, failureMessage: safeMessage(error), updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    return false;
  }
  await db.update(intakeSessions).set({ status: "queued", failureCode: "retryable_provider_error", failureMessage: safeMessage(error), updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
  await enqueueIntakeSession(sessionId, { delayMs: decision.delayMs, jobId: `intake--${sessionId}--retry-${attempt}` });
  return true;
};

export const processIntakeSession = async (sessionId: string, deps: { classifySafety?: SafetyClassifierFn } = {}) => {
  const db = getDb();
  const session = await db.query.intakeSessions.findFirst({ where: eq(intakeSessions.id, sessionId) });
  if (!session || session.status === "completed") return session?.videoRunId ?? null;

  const claimed = await db.update(intakeSessions).set({ status: "running", updatedAt: new Date(), failureCode: null, failureMessage: null }).where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.status, "queued"))).returning({ id: intakeSessions.id });
  if (!claimed.length && session.status === "running") return null;
  if (!claimed.length) return session.videoRunId ?? null;

  const input = IntakeSessionInputSchema.parse(session.input);
  const projection = projectIntakeContext(input.requestText);
  const contextManifest = intakeContextManifest(projection);

  try {
    assertIntakeCapabilities();
  } catch (error) {
    await db.update(intakeSessions).set({ status: "failed", failureCode: "intake_capability_unavailable", failureMessage: safeMessage(error), updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    throw error;
  }

  const nextAttempt = async () => {
    const previous = await db.select({ attempt: max(intakeAttempts.attempt) }).from(intakeAttempts).where(eq(intakeAttempts.sessionId, sessionId));
    return (previous[0]?.attempt ?? 0) + 1;
  };

  // --- Safety gate: before any billable briefing call or run identity ---
  const safetyAttempt = await nextAttempt();
  const safetyStarted = Date.now();
  let gate: SafetyGateResult;
  try {
    gate = await runSafetyGate(projection.projection, deps.classifySafety);
  } catch (error) {
    await recordAttempt({ sessionId, attempt: safetyAttempt, provider: "ai-gateway", model: "gpt-oss-safeguard-20b", promptVersion: SAFETY_PROMPT_VERSION, outcome: "failed", latencyMs: Date.now() - safetyStarted, error, contextManifest: { ...contextManifest, kind: "safety-classification", agentId: SAFETY_AGENT_ID, tools: [] } });
    await scheduleRetry(sessionId, safetyAttempt, error, "safety_classification_failed");
    return null;
  }
  if (gate.modelCalled) {
    await recordAttempt({ sessionId, attempt: safetyAttempt, provider: "ai-gateway", model: "gpt-oss-safeguard-20b", promptVersion: SAFETY_PROMPT_VERSION, outcome: "completed", latencyMs: Date.now() - safetyStarted, usage: gate.usage, contextManifest: { ...contextManifest, kind: "safety-classification", agentId: SAFETY_AGENT_ID, tools: [], label: gate.classification.label } });
  }
  if (!gate.allowed) {
    await db.update(intakeSessions).set({ status: "failed", failureCode: gate.failureCode ?? "safety_policy_rejected", failureMessage: gate.classification.rationale, updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    return null;
  }

  // --- Briefing call + deterministic normalization ---
  const attempt = await nextAttempt();
  const started = Date.now();
  try {
    const result = await generateIntakeBrief({ requestText: projection.projection, language: input.language });
    const resolved = normalizeIntakeBrief(result.value);
    const domain = validateDomainClassification({ agentDomain: resolved.domain, requestText: projection.projection });
    const brief = { ...resolved, domain: domain.domain };
    await recordAttempt({ sessionId, attempt, provider: "ai-gateway", model: "gpt-5.6-luna", promptVersion: INTAKE_PROMPT_VERSION, outcome: "completed", latencyMs: Date.now() - started, usage: result.usage, contextManifest: { ...contextManifest, kind: "brief", agentId: INTAKE_AGENT_ID, tools: [], safety: gate.classification, domainEvidence: domain } });

    const runId = await createVideoRun({
      ...brief,
      sources: input.source ? [input.source] : [],
    });
    await db.update(intakeSessions).set({ status: "completed", brief, briefHash: hash(brief), videoRunId: runId, updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    return runId;
  } catch (error) {
    await recordAttempt({ sessionId, attempt, provider: "ai-gateway", model: "gpt-5.6-luna", promptVersion: INTAKE_PROMPT_VERSION, outcome: "failed", latencyMs: Date.now() - started, error, contextManifest: { ...contextManifest, kind: "brief", agentId: INTAKE_AGENT_ID, tools: [] } });
    const failureCode = isSafetyFailureCode((error as { failureCode?: string } | null)?.failureCode) ? (error as { failureCode: string }).failureCode : "intake_failed";
    await scheduleRetry(sessionId, attempt, error, failureCode);
    return null;
  }
};

export { classifyIntakeFailure, normalizeIntakeBrief, validateDomainClassification, projectIntakeContext, intakeContextManifest };
export { INTAKE_DEFAULTS, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, COMPLEXITY_DURATION_TIERS, deriveDurationSeconds, clampDurationSeconds, clampComplexity } from "./intake-normalize.ts";
export { DOMAIN_KEYWORD_TABLE, DOMAIN_PRECEDENCE } from "./domain-routing.ts";
export { MAX_INTAKE_ATTEMPTS, decideIntakeRetry, nextRetryDelayMs } from "./pipeline/intake-retry.ts";
