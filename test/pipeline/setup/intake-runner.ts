import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import type { ResolvedIntakeBriefV3 } from "@upcraft/contracts";
import { resolveModelRoute } from "@upcraft/providers";
import { assertIntakeCapabilities, generateIntakeBrief, INTAKE_AGENT_ID, INTAKE_PROMPT_VERSION } from "@upcraft/providers/intake";
import { normalizeIntakeBrief } from "@upcraft/pipeline/intake";
import { intakeContextManifest, projectIntakeContext } from "./intake-hardening/projection.ts";
import { validateDomainClassification, type DomainClassification } from "./intake-hardening/domain-routing.ts";
import { moderateRequest, type SafetyClassification, type SafetyClassifier } from "./intake-hardening/safety.ts";
import { buildIntakeAttemptRecord } from "./intake-hardening/usage.ts";
import { classifyIntakeFailure, decideIntakeRetry, MAX_INTAKE_ATTEMPTS } from "./intake-hardening/retry-policy.ts";
import { logDirFor, ndjsonPathFor, sessionLogPathFor } from "./logger.ts";
import { loadRepoEnv } from "./load-env.ts";

/**
 * Sandbox of the hardened M1 intake path.
 *
 * It runs the real `generateIntakeBrief` provider call through the real route and
 * then applies the intake-hardening modules: bounded context projection with
 * recorded metadata, code-owned normalization, deterministic domain validation,
 * classified retry with backoff, and usage/pricing stamping. It does not touch
 * the production intake code — that is a Phase-6 promotion.
 *
 * When `AI_GATEWAY_API_KEY` is absent the runner reports a visible BLOCKED state
 * instead of fabricating a brief.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type IntakeHarnessResult = {
  sessionId: string;
  status: "passed" | "blocked" | "failed";
  attempts: number;
  blockReason?: string;
  failureMessage?: string;
  failureCode?: string;
  brief?: ResolvedIntakeBriefV3;
  domain?: DomainClassification;
  safety?: SafetyClassification;
  complexity?: number | null;
};

export const runIntakeHarness = async (params: {
  requestText: string;
  language?: string;
  maxChars?: number;
  sleepMs?: (ms: number) => Promise<void>;
  /** Injectable classifier; harness tests pass a stub so nothing harmful is sent. */
  safetyClassifier?: SafetyClassifier;
}): Promise<IntakeHarnessResult> => {
  loadRepoEnv();
  const sessionId = randomUUID();
  const language = params.language ?? "en";
  const sleepFn = params.sleepMs ?? sleep;
  const ndjsonPath = ndjsonPathFor(sessionId, "s00-intake");
  const sessionPath = sessionLogPathFor(sessionId);
  await mkdir(logDirFor(sessionId), { recursive: true });
  const log = (message: string) => appendFile(sessionPath, `${new Date().toISOString()} [s00-intake] ${message}\n`, "utf8");

  const projection = projectIntakeContext(params.requestText, { ...(params.maxChars ? { maxChars: params.maxChars } : {}) });
  await log(`projection=${projection.projectionVersion} original=${projection.originalChars} projected=${projection.projectedChars} truncated=${projection.truncated}`);

  // Safety gate runs first: it is deterministic, needs no credentials, and must
  // reject before any billable call or run identity is reserved.
  const moderation = await moderateRequest({ requestText: projection.projection, ...(params.safetyClassifier ? { classify: params.safetyClassifier } : {}) });
  if (!moderation.allowed) {
    await log(`BLOCKED safety gate label=${moderation.classification.label} failureCode=${moderation.failureCode}`);
    return {
      sessionId,
      status: "failed",
      attempts: 0,
      failureCode: moderation.failureCode ?? "safety_policy_rejected",
      failureMessage: moderation.classification.rationale,
      safety: moderation.classification,
    };
  }

  try {
    assertIntakeCapabilities();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "intake capability is unavailable";
    await log(`BLOCKED ${reason}`);
    return { sessionId, status: "blocked", attempts: 0, blockReason: reason, safety: moderation.classification };
  }

  const contextManifest = intakeContextManifest(projection);
  const route = resolveModelRoute("intake-brief");

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_INTAKE_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const result = await generateIntakeBrief({ requestText: projection.projection, language });
      const normalized = normalizeIntakeBrief(result.value);
      const domain = validateDomainClassification({ agentDomain: normalized.domain, requestText: projection.projection });
      const brief: ResolvedIntakeBriefV3 = { ...normalized, domain: domain.domain };
      const complexity = normalized.computedComplexity;
      const durationProvided = normalized.durationProvided;
      const record = buildIntakeAttemptRecord({
        usage: result.usage,
        route,
        promptVersion: INTAKE_PROMPT_VERSION,
        latencyMs: Date.now() - started,
        outcome: "completed",
        contextManifest: { ...contextManifest, agentId: INTAKE_AGENT_ID, tools: [], safety: moderation.classification, domainEvidence: domain, complexity, durationProvided },
      });
      await appendFile(ndjsonPath, `${JSON.stringify({ attempt, ...record })}\n`, "utf8");
      await log(`completed attempt=${attempt} domain=${domain.domain}${domain.override ? ` (override from ${domain.agentDomain}: ${domain.matchedKeywords.join(", ")})` : ""} complexity=${complexity} duration=${brief.durationSeconds}s`);
      return { sessionId, status: "passed", attempts: attempt, brief, domain, safety: moderation.classification, complexity };
    } catch (error) {
      lastError = error;
      const decision = decideIntakeRetry({ attemptCount: attempt, error });
      const record = buildIntakeAttemptRecord({
        usage: {},
        route,
        promptVersion: INTAKE_PROMPT_VERSION,
        latencyMs: Date.now() - started,
        outcome: "failed",
        errorCode: classifyIntakeFailure(error),
        contextManifest: { ...contextManifest, agentId: INTAKE_AGENT_ID, tools: [] },
      });
      await appendFile(ndjsonPath, `${JSON.stringify({ attempt, ...record })}\n`, "utf8");
      await log(`failed attempt=${attempt} class=${decision.failureClass} retry=${decision.retry}${decision.retry ? ` delayMs=${decision.delayMs}` : ""}`);
      if (!decision.retry) return { sessionId, status: "failed", attempts: attempt, failureMessage: error instanceof Error ? error.message.slice(0, 500) : "intake briefing failed" };
      await sleepFn(decision.delayMs);
    }
  }

  return { sessionId, status: "failed", attempts: MAX_INTAKE_ATTEMPTS, failureMessage: lastError instanceof Error ? lastError.message.slice(0, 500) : "intake briefing failed" };
};
