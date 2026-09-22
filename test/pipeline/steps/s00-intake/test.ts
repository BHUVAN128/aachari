import assert from "node:assert/strict";
import { ZodError } from "zod";
import { CreateRunInputSchema, DomainSchema } from "@upcraft/contracts";
import { resolveModelRoute } from "@upcraft/providers";
import { buildRunInput, HARNESS_INPUTS } from "../../setup/inputs.ts";
import { runIntakeHarness } from "../../setup/intake-runner.ts";
import {
  INTAKE_DEFAULTS,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  clampDurationSeconds,
  defaultedFields,
  normalizeIntakeBrief,
  SandboxIntakeBriefSchema,
} from "../../setup/intake-hardening/defaults.ts";
import { DEFAULT_INTAKE_CONTEXT_CHARS, projectIntakeContext } from "../../setup/intake-hardening/projection.ts";
import { validateDomainClassification } from "../../setup/intake-hardening/domain-routing.ts";
import { classifyIntakeFailure, decideIntakeRetry, MAX_INTAKE_ATTEMPTS, nextRetryDelayMs } from "../../setup/intake-hardening/retry-policy.ts";
import { buildIntakeAttemptRecord } from "../../setup/intake-hardening/usage.ts";

/**
 * s00 — Intake hardening (pre-run).
 *
 * Deterministic assertions for the sandbox intake modules plus an optional live
 * briefing call through the real gateway route. The live call is skipped with a
 * visible BLOCKED reason when `AI_GATEWAY_API_KEY` is absent.
 */

const sandboxBrief = (overrides: Partial<Record<string, unknown>> = {}) =>
  SandboxIntakeBriefSchema.parse({
    schemaVersion: "intake-brief/v2",
    topic: "How photosynthesis works",
    domain: "standard",
    language: "en",
    learningLevel: null,
    audienceCategory: null,
    durationSeconds: null,
    visualProfile: null,
    aspectRatio: null,
    requestedDestination: null,
    ...overrides,
  });

const main = async () => {
  // --- 1A: the broken medical-adjacent harness input is fixed ---
  assert.equal(HARNESS_INPUTS["medical-adjacent"].domain, "standard", "medical topics must freeze as standard, not a medical domain");
  const medicalInput = await buildRunInput("medical-adjacent");
  const parsed = CreateRunInputSchema.parse(medicalInput);
  assert.equal(parsed.domain, "standard");
  assert.ok(DomainSchema.safeParse(parsed.domain).success);
  console.log("  1A: medical-adjacent harness input parses with domain=standard.");

  // --- 1B: code-owned defaults ---
  const normalized = normalizeIntakeBrief(sandboxBrief());
  assert.equal(normalized.learningLevel, INTAKE_DEFAULTS.learningLevel);
  assert.equal(normalized.audienceCategory, INTAKE_DEFAULTS.audienceCategory);
  assert.equal(normalized.durationSeconds, INTAKE_DEFAULTS.durationSeconds);
  assert.equal(normalized.aspectRatio, INTAKE_DEFAULTS.aspectRatio);
  assert.equal(normalized.visualProfile, INTAKE_DEFAULTS.visualProfile);
  assert.equal(normalized.requestedDestination, INTAKE_DEFAULTS.requestedDestination);
  assert.equal(defaultedFields(sandboxBrief()).length, 6, "every omitted configuration field must be reported as defaulted");

  const explicit = normalizeIntakeBrief(sandboxBrief({ learningLevel: "College year 1", durationSeconds: 300, aspectRatio: "9:16" }));
  assert.equal(explicit.learningLevel, "College year 1");
  assert.equal(explicit.durationSeconds, 300);
  assert.equal(explicit.aspectRatio, "9:16");
  assert.equal(defaultedFields(sandboxBrief({ durationSeconds: 300 })).length, 5);
  console.log("  1B: normalizeIntakeBrief applies code defaults and preserves explicit values.");

  assert.equal(clampDurationSeconds(5), MIN_DURATION_SECONDS);
  assert.equal(clampDurationSeconds(5_000), MAX_DURATION_SECONDS);
  assert.equal(normalizeIntakeBrief(sandboxBrief({ durationSeconds: 5_000 })).durationSeconds, MAX_DURATION_SECONDS);
  console.log("  1B: duration clamps into the frozen 15–900s range.");

  // --- 1C: bounded intake-context projection ---
  const short = projectIntakeContext("photosynthesis working");
  assert.equal(short.truncated, false);
  assert.equal(short.projection, "photosynthesis working");
  const long = projectIntakeContext("x".repeat(5_000));
  assert.equal(long.truncated, true);
  assert.equal(long.projectedChars, DEFAULT_INTAKE_CONTEXT_CHARS);
  assert.equal(long.originalChars, 5_000);
  assert.equal(long.projection.length, DEFAULT_INTAKE_CONTEXT_CHARS);
  assert.equal(long.projectionVersion, "intake-context/v1");
  assert.throws(() => projectIntakeContext("x", { maxChars: 0 }));
  console.log("  1C: projectIntakeContext bounds the M1 call and records truncation.");

  // --- 1D: deterministic domain-validation fallback ---
  const routing: Array<{ agent: "standard" | "engineering" | "client-production"; text: string; domain: string; override: boolean }> = [
    { agent: "standard", text: "Design a voltage divider circuit with a resistor", domain: "engineering", override: true },
    { agent: "engineering", text: "Explain how photosynthesis works in a leaf cell", domain: "standard", override: true },
    { agent: "client-production", text: "A branded campaign for our client", domain: "client-production", override: false },
    { agent: "standard", text: "Explain how rainbows form", domain: "standard", override: false },
    { agent: "client-production", text: "How a patient's disease is diagnosed", domain: "standard", override: true },
  ];
  for (const entry of routing) {
    const result = validateDomainClassification({ agentDomain: entry.agent, requestText: entry.text });
    assert.equal(result.domain, entry.domain, `"${entry.text}" should route to ${entry.domain}, got ${result.domain}`);
    assert.equal(result.override, entry.override, `"${entry.text}" override should be ${entry.override}`);
  }
  assert.throws(() => validateDomainClassification({ agentDomain: "medical" as never, requestText: "anything" }), "a domain outside the approved enum must be a contract violation");
  console.log(`  1D: ${routing.length} domain-routing cases pass; agent defers when no keyword fires.`);

  // --- 1E: classified retry with backoff ---
  assert.equal(classifyIntakeFailure({ statusCode: 429 }), "rate_limit");
  assert.equal(classifyIntakeFailure({ status: 503 }), "server_error");
  assert.equal(classifyIntakeFailure({ statusCode: 401 }), "authentication");
  assert.equal(classifyIntakeFailure({ code: "ECONNRESET" }), "network");
  assert.equal(classifyIntakeFailure(new ZodError([])), "validation");
  assert.equal(typeof nextRetryDelayMs({ attemptCount: 1, failureClass: "rate_limit", random: () => 0.5 }), "number");
  assert.equal(nextRetryDelayMs({ attemptCount: 1, failureClass: "rate_limit", random: () => 0.5 }), 2_000);
  assert.equal(nextRetryDelayMs({ attemptCount: 2, failureClass: "server_error", random: () => 0.5 }), 1_000);

  const rateLimited = decideIntakeRetry({ attemptCount: 1, error: { statusCode: 429 }, random: () => 0.5 });
  assert.equal(rateLimited.retry, true);
  assert.equal(rateLimited.retry && rateLimited.delayMs, 2_000);
  const exhausted = decideIntakeRetry({ attemptCount: MAX_INTAKE_ATTEMPTS, error: { statusCode: 429 } });
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.retry === false && exhausted.reason, "attempt_budget_exhausted");
  const permanent = decideIntakeRetry({ attemptCount: 1, error: { statusCode: 400 } });
  assert.equal(permanent.retry, false);
  assert.equal(permanent.retry === false && permanent.reason, "not_retryable_failure");
  console.log("  1E: transient failures retry with backoff+jitter; auth/quota/validation/budget do not.");

  // --- 1F: usage + pricing stamping ---
  const intakeRoute = resolveModelRoute("intake-brief");
  const unpriced = buildIntakeAttemptRecord({ usage: { inputTokens: 100, outputTokens: 20 }, route: intakeRoute, promptVersion: "intake-briefing/v2", latencyMs: 42, outcome: "completed" });
  assert.equal(unpriced.pricingVersion, intakeRoute.pricingVersion);
  assert.equal(unpriced.costMicrounits, null);
  assert.equal(unpriced.unpriced, true);

  const pricedRoute = resolveModelRoute("planning");
  const priced = buildIntakeAttemptRecord({ usage: { inputTokens: 100, outputTokens: 20 }, route: pricedRoute, promptVersion: "intake-briefing/v2", latencyMs: 42, outcome: "completed" });
  assert.equal(priced.pricingVersion, pricedRoute.pricingVersion);
  assert.equal(priced.costMicrounits, 100 * 2 + 20 * 12);
  assert.equal(priced.unpriced, false);
  console.log("  1F: pricing version always stamped; cost from the shared pricing math, unpriced recorded explicitly.");

  // --- Optional live run through the real gateway route ---
  const live = await runIntakeHarness({ requestText: "photosynthesis working" });
  if (live.status === "blocked") {
    console.log(`s00 BLOCKED (credential): ${live.blockReason}`);
    console.log("s00 deterministic PASS (live intake skipped)");
    return;
  }
  assert.equal(live.status, "passed", `live intake must not fail: ${live.failureMessage ?? ""}`);
  assert.ok(live.brief, "live intake must return a normalized brief");
  assert.equal(live.brief!.schemaVersion, "intake-brief/v2");
  assert.ok(live.brief!.durationSeconds >= MIN_DURATION_SECONDS && live.brief!.durationSeconds <= MAX_DURATION_SECONDS);
  console.log(`  live: session=${live.sessionId} attempts=${live.attempts} domain=${live.domain?.domain} duration=${live.brief!.durationSeconds}s`);
  console.log("s00 PASS");
};

main().catch((error) => {
  console.error("s00 FAIL:", error);
  process.exit(1);
});
