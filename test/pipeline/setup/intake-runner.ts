import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import type { IntakeBriefV3, ResolvedIntakeBriefV3 } from "@upcraft/contracts";
import { resolveModelRoute, type ProviderResult } from "@upcraft/providers";
import { assertIntakeCapabilities, generateIntakeBrief, INTAKE_AGENT_ID, INTAKE_PROMPT_VERSION } from "@upcraft/providers/intake";
import { normalizeIntakeBrief } from "@upcraft/pipeline/intake";
import { intakeContextManifest, projectIntakeContext } from "./intake-hardening/projection.ts";
import { validateDomainClassification, type DomainClassification } from "./intake-hardening/domain-routing.ts";
import { moderateRequest, type SafetyClassification, type SafetyClassifier } from "./intake-hardening/safety.ts";
import { buildIntakeAttemptRecord } from "./intake-hardening/usage.ts";
import { classifyIntakeFailure, decideIntakeRetry, MAX_INTAKE_ATTEMPTS } from "./intake-hardening/retry-policy.ts";
import {
  assessRequestQuality,
  CLARIFICATION_AGENT_ID,
  CLARIFICATION_PROMPT_VERSION,
  decideClarification,
  hashTransientInput,
  MAX_CLARIFICATION_ROUNDS,
  scrubTopicForSnapshot,
  type ClarificationAssessment,
  type ClarificationAssessor,
  type ClarificationTurn,
  type IntakeClarification,
} from "./intake-hardening/clarification.ts";
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
  status: "passed" | "blocked" | "failed" | "needs_input";
  attempts: number;
  blockReason?: string;
  failureMessage?: string;
  failureCode?: string;
  brief?: ResolvedIntakeBriefV3;
  domain?: DomainClassification;
  safety?: SafetyClassification;
  complexity?: number | null;
  clarification?: IntakeClarification;
};

export const runIntakeHarness = async (params: {
  requestText: string;
  language?: string;
  maxChars?: number;
  sleepMs?: (ms: number) => Promise<void>;
  /** Injectable classifier; harness tests pass a stub so nothing harmful is sent. */
  safetyClassifier?: SafetyClassifier;
  /** Prior clarification turns; presence marks a resume and bypasses heuristics. */
  priorTurns?: ClarificationTurn[];
  /** Injectable clarification assessor; a stub keeps the harness offline. */
  clarificationAssessor?: ClarificationAssessor;
  /** Injectable briefing call; a stub lets the state machine be tested offline. */
  briefGenerator?: (params: { requestText: string; language: string }) => Promise<ProviderResult<IntakeBriefV3>>;
}): Promise<IntakeHarnessResult> => {
  loadRepoEnv();
  const sessionId = randomUUID();
  const language = params.language ?? "en";
  const sleepFn = params.sleepMs ?? sleep;
  const priorTurns = params.priorTurns ?? [];
  const isResume = priorTurns.length > 0;
  const roundsUsed = priorTurns.length;
  const generateBrief = params.briefGenerator ?? generateIntakeBrief;
  const ndjsonPath = ndjsonPathFor(sessionId, "s00-intake");
  const sessionPath = sessionLogPathFor(sessionId);
  await mkdir(logDirFor(sessionId), { recursive: true });
  const log = (message: string) => appendFile(sessionPath, `${new Date().toISOString()} [s00-intake] ${message}\n`, "utf8");

  const projection = projectIntakeContext(params.requestText, { ...(params.maxChars ? { maxChars: params.maxChars } : {}) });
  await log(`projection=${projection.projectionVersion} original=${projection.originalChars} projected=${projection.projectedChars} truncated=${projection.truncated} resume=${isResume} roundsUsed=${roundsUsed}`);

  // Safety gate runs first on the NEW user text: it is deterministic, needs no
  // credentials, and must reject before any billable call or run identity.
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

  const route = resolveModelRoute("intake-brief");

  // Clarification triage runs ONLY on the first call. On resume, heuristics are
  // skipped by construction (RULE 0 in `assessRequestQuality`), so an answer such
  // as "Option A" is judged by the brief model, not re-flagged. Fix #1.
  if (!isResume) {
    const quality = assessRequestQuality(projection.projection, priorTurns);
    let assessment: ClarificationAssessment | undefined;
    if (quality.verdict === "unsure" && params.clarificationAssessor) {
      const assessStarted = Date.now();
      try {
        const assessed = await params.clarificationAssessor({ requestText: projection.projection, priorTurns });
        assessment = assessed.assessment;
        const record = buildIntakeAttemptRecord({
          usage: assessed.usage,
          route,
          promptVersion: CLARIFICATION_PROMPT_VERSION,
          latencyMs: assessed.latencyMs,
          outcome: "completed",
          contextManifest: { agentId: CLARIFICATION_AGENT_ID, projection: CLARIFICATION_PROMPT_VERSION, inputHash: hashTransientInput(projection.projection), tools: [], signals: quality.signals },
        });
        await appendFile(ndjsonPath, `${JSON.stringify({ attempt: 1, agent: CLARIFICATION_AGENT_ID, ...record })}\n`, "utf8");
        await log(`clarification assessor needsClarification=${assessment.needsClarification}`);
      } catch (error) {
        const failureClass = classifyIntakeFailure(error);
        const record = buildIntakeAttemptRecord({
          usage: {},
          route,
          promptVersion: CLARIFICATION_PROMPT_VERSION,
          latencyMs: Date.now() - assessStarted,
          outcome: "failed",
          errorCode: failureClass,
          contextManifest: { agentId: CLARIFICATION_AGENT_ID, projection: CLARIFICATION_PROMPT_VERSION, inputHash: hashTransientInput(projection.projection), tools: [], signals: quality.signals },
        });
        await appendFile(ndjsonPath, `${JSON.stringify({ attempt: 1, agent: CLARIFICATION_AGENT_ID, ...record })}\n`, "utf8");
        await log(`clarification assessor failed class=${failureClass}`);
        return { sessionId, status: "failed", attempts: 1, failureCode: failureClass, failureMessage: error instanceof Error ? error.message.slice(0, 500) : "clarification assessment failed", safety: moderation.classification };
      }
    }

    const decision = decideClarification({ quality, ...(assessment ? { assessment } : {}), roundsUsed });
    if (decision.action === "exhausted") {
      await log(`BLOCKED clarification rounds exhausted (${roundsUsed}/${MAX_CLARIFICATION_ROUNDS}) verdict=${quality.verdict}`);
      return { sessionId, status: "failed", attempts: 0, failureCode: "intake_clarification_exhausted", failureMessage: "request remained ambiguous after the clarification budget", safety: moderation.classification };
    }
    if (decision.action === "ask") {
      await log(`needs_input kind=${decision.clarification.kind} round=${decision.clarification.round} options=${decision.clarification.options.length} signals=${quality.signals.join(",")}`);
      return { sessionId, status: "needs_input", attempts: 0, clarification: decision.clarification, safety: moderation.classification };
    }
    await log(`quality=${quality.verdict} proceeding to briefing`);
  }

  // Resume context is TRANSIENT model input only. It is never written to a
  // snapshot, attempt record, or telemetry field — only its hash is recorded.
  const requestForBrief = isResume
    ? [...priorTurns.map((turn) => `Clarifying question: ${turn.asked.question}\nUser answer: ${turn.answer}`), `User answer: ${projection.projection}`].join("\n")
    : projection.projection;
  const contextManifest = { ...intakeContextManifest(projection), hash: hashTransientInput(requestForBrief) };

  // Capability preflight is only required for a real provider call. An injected
  // generator/assessor owns its own route, so the offline harness can drive the
  // full state machine without credentials (and the live path stays visibly blocked).
  if (!params.briefGenerator) {
    try {
      assertIntakeCapabilities();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "intake capability is unavailable";
      await log(`BLOCKED ${reason}`);
      return { sessionId, status: "blocked", attempts: 0, blockReason: reason, safety: moderation.classification };
    }
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_INTAKE_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const result = await generateBrief({ requestText: requestForBrief, language });
      const normalized = normalizeIntakeBrief(result.value);
      const domain = validateDomainClassification({ agentDomain: normalized.domain, requestText: requestForBrief });
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

      // Post-brief backstop (fix #6): a surviving brief with an unparseable topic
      // must never freeze into `input-snapshot/v1`. It routes back to one final
      // (capped) clarification round instead.
      const scrub = scrubTopicForSnapshot(brief.topic);
      if (scrub.scrubbed) {
        const decision = decideClarification({ quality: { verdict: "unparseable", signals: ["brief_topic_unparseable"] }, roundsUsed });
        if (decision.action === "ask") {
          await log(`needs_input kind=${decision.clarification.kind} round=${decision.clarification.round} reason=brief_topic_unparseable`);
          return { sessionId, status: "needs_input", attempts: attempt, clarification: decision.clarification, safety: moderation.classification };
        }
        await log(`BLOCKED brief topic unparseable; clarification rounds exhausted (${roundsUsed}/${MAX_CLARIFICATION_ROUNDS})`);
        return { sessionId, status: "failed", attempts: attempt, failureCode: "intake_clarification_exhausted", failureMessage: "extracted topic could not be validated", safety: moderation.classification };
      }

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
