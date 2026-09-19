import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import { IntakeSessionInputSchema, type IntakeSessionInput } from "@upcraft/contracts";
import { getDb, intakeAttempts, intakeSessions } from "@upcraft/db";
import { assertIntakeCapabilities, generateIntakeBrief, INTAKE_AGENT_ID, INTAKE_MODEL, INTAKE_PROMPT_VERSION } from "@upcraft/providers/intake";
import type { ProviderUsageSnapshot } from "@upcraft/providers/usage";
import { createVideoRun } from "./runs.ts";
import { scheduleIntakeSession } from "./outbox.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const createIntakeSession = async (rawInput: IntakeSessionInput, sessionId = randomUUID()) => {
  const input = IntakeSessionInputSchema.parse(rawInput);
  const db = getDb();
  await db.insert(intakeSessions).values({ id: sessionId, input, inputHash: hash(input), status: "queued" });
  await scheduleIntakeSession(sessionId);
  return sessionId;
};

const retryable = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { statusCode?: number; status?: number; code?: string };
  const status = candidate.statusCode ?? candidate.status;
  return status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500) || ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(candidate.code ?? "");
};

const safeMessage = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : "Intake briefing failed.";

const recordAttempt = async (sessionId: string, attempt: number, params: {
  outcome: "completed" | "failed";
  latencyMs: number;
  error?: unknown;
  usage?: ProviderUsageSnapshot;
}) => {
  const db = getDb();
  const errorCode = params.error && typeof params.error === "object" && "code" in params.error ? String((params.error as { code?: unknown }).code) : undefined;
  await db.insert(intakeAttempts).values({
    sessionId, attempt, provider: "openai", model: params.usage?.model ?? INTAKE_MODEL(), requestId: params.usage?.requestId,
    promptVersion: INTAKE_PROMPT_VERSION, outcome: params.outcome, errorCode, errorMessage: params.error ? safeMessage(params.error) : null,
    inputTokens: params.usage?.inputTokens, cachedInputTokens: params.usage?.cachedInputTokens, outputTokens: params.usage?.outputTokens,
    reasoningTokens: params.usage?.reasoningTokens, inputCharacters: params.usage?.inputCharacters, outputCharacters: params.usage?.outputCharacters,
    costMicrounits: null, pricingVersion: null, contextManifest: { agentId: INTAKE_AGENT_ID, tools: [] }, latencyMs: params.latencyMs,
  }).onConflictDoNothing();
};

export const processIntakeSession = async (sessionId: string) => {
  const db = getDb();
  const session = await db.query.intakeSessions.findFirst({ where: eq(intakeSessions.id, sessionId) });
  if (!session || session.status === "completed") return session?.videoRunId ?? null;

  const claimed = await db.update(intakeSessions).set({ status: "running", updatedAt: new Date(), failureCode: null, failureMessage: null }).where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.status, "queued"))).returning({ id: intakeSessions.id });
  if (!claimed.length && session.status === "running") return null;
  if (!claimed.length) return session.videoRunId ?? null;

  const input = IntakeSessionInputSchema.parse(session.input);
  const previous = await db.select({ attempt: max(intakeAttempts.attempt) }).from(intakeAttempts).where(eq(intakeAttempts.sessionId, sessionId));
  const attempt = (previous[0]?.attempt ?? 0) + 1;
  const started = Date.now();
  let result;
  try {
    assertIntakeCapabilities();
    result = await generateIntakeBrief({ requestText: input.requestText, language: input.language });
    await recordAttempt(sessionId, attempt, { outcome: "completed", latencyMs: Date.now() - started, usage: result.usage });
  } catch (error) {
    await recordAttempt(sessionId, attempt, { outcome: "failed", latencyMs: Date.now() - started, error });
    const willRetry = retryable(error) && attempt < 3;
    await db.update(intakeSessions).set({ status: willRetry ? "queued" : "failed", failureCode: willRetry ? "retryable_provider_error" : "intake_failed", failureMessage: safeMessage(error), updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    throw error;
  }

  try {
    const runId = await createVideoRun({
      ...result.value,
      sourceIds: [],
      aspectRatio: "16:9",
      requestedDestination: "local",
      sources: [input.source],
    });
    await db.update(intakeSessions).set({ status: "completed", brief: result.value, briefHash: hash(result.value), videoRunId: runId, updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    return runId;
  } catch (error) {
    await db.update(intakeSessions).set({ status: "failed", failureCode: "run_creation_failed", failureMessage: safeMessage(error), updatedAt: new Date() }).where(eq(intakeSessions.id, sessionId));
    throw error;
  }
};
