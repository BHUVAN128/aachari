import { describe, expect, it } from "vitest";
import { IntakeBriefV3Schema, IntakeSessionInputSchema } from "@upcraft/contracts";
import { COMPLEXITY_DURATION_TIERS, INTAKE_DEFAULTS, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS, normalizeIntakeBrief } from "../src/intake-normalize.ts";
import { validateDomainClassification } from "../src/domain-routing.ts";
import { projectIntakeContext } from "../src/intake-projection.ts";
import { classifyIntakeFailure, decideIntakeRetry, MAX_INTAKE_ATTEMPTS, nextRetryDelayMs } from "../src/pipeline/intake-retry.ts";

const extraction = (overrides: Record<string, unknown> = {}) =>
  IntakeBriefV3Schema.parse({
    schemaVersion: "intake-brief/v3",
    topic: "How photosynthesis works",
    language: "en",
    domain: "standard",
    learningLevel: null,
    audienceCategory: null,
    durationSeconds: null,
    visualProfile: null,
    aspectRatio: null,
    requestedDestination: null,
    computedComplexity: null,
    durationProvided: false,
    ...overrides,
  });

describe("chat intake contracts", () => {
  it("accepts a photosynthesis request with a user-provided source", () => {
    const input = IntakeSessionInputSchema.parse({
      schemaVersion: "intake-session-input/v1",
      requestText: "photosynthesis working",
      language: "en",
      source: { kind: "text", name: "Primary source", value: "Photosynthesis converts light energy into chemical energy." },
    });
    expect(input.requestText).toBe("photosynthesis working");
  });

  it("allows a chat session without a source so research can retrieve one from the web", () => {
    const input = IntakeSessionInputSchema.parse({ schemaVersion: "intake-session-input/v1", requestText: "photosynthesis working", language: "en" });
    expect(input.source).toBeUndefined();
  });
});

describe("intake normalization (Point 1)", () => {
  it("coalesces every omitted configuration field from code defaults", () => {
    const brief = normalizeIntakeBrief(extraction());
    expect(brief.learningLevel).toBe(INTAKE_DEFAULTS.learningLevel);
    expect(brief.audienceCategory).toBe(INTAKE_DEFAULTS.audienceCategory);
    expect(brief.durationSeconds).toBe(INTAKE_DEFAULTS.durationSeconds);
    expect(brief.aspectRatio).toBe(INTAKE_DEFAULTS.aspectRatio);
    expect(brief.visualProfile).toBe(INTAKE_DEFAULTS.visualProfile);
    expect(brief.requestedDestination).toBe(INTAKE_DEFAULTS.requestedDestination);
  });

  it("preserves a user-stated duration and clamps it into the frozen range", () => {
    expect(normalizeIntakeBrief(extraction({ durationSeconds: 300, durationProvided: true })).durationSeconds).toBe(300);
    expect(normalizeIntakeBrief(extraction({ durationSeconds: 5, durationProvided: true })).durationSeconds).toBe(MIN_DURATION_SECONDS);
    expect(normalizeIntakeBrief(extraction({ durationSeconds: 5_000, durationProvided: true })).durationSeconds).toBe(MAX_DURATION_SECONDS);
  });
});

describe("complexity-derived duration (Point 3)", () => {
  it("derives a duration tier only when the user gave none", () => {
    expect(normalizeIntakeBrief(extraction({ computedComplexity: 1 })).durationSeconds).toBe(COMPLEXITY_DURATION_TIERS[1]);
    expect(normalizeIntakeBrief(extraction({ computedComplexity: 5 })).durationSeconds).toBe(COMPLEXITY_DURATION_TIERS[5]);
    expect(normalizeIntakeBrief(extraction({ durationSeconds: 200, durationProvided: true, computedComplexity: 5 })).durationSeconds).toBe(200);
  });
});

describe("domain-validation fallback (Point 5)", () => {
  it("overrides an obvious misclassification and records the evidence", () => {
    const result = validateDomainClassification({ agentDomain: "standard", requestText: "Design a voltage divider circuit with a resistor" });
    expect(result.domain).toBe("engineering");
    expect(result.override).toBe(true);
    expect(result.matchedKeywords).toContain("circuit");
  });

  it("defers to the agent when no keyword fires", () => {
    expect(validateDomainClassification({ agentDomain: "client-production", requestText: "Explain how rainbows form" })).toMatchObject({ domain: "client-production", override: false });
  });

  it("routes health/medical phrasing to standard, never a medical domain", () => {
    expect(validateDomainClassification({ agentDomain: "client-production", requestText: "How a patient's disease is diagnosed" }).domain).toBe("standard");
  });
});

describe("classified retry (Point 7b)", () => {
  it("retries transient failures with backoff and jitter", () => {
    expect(classifyIntakeFailure({ statusCode: 429 })).toBe("rate_limit");
    expect(classifyIntakeFailure({ status: 503 })).toBe("server_error");
    expect(nextRetryDelayMs({ attemptCount: 1, failureClass: "rate_limit", random: () => 0.5 })).toBe(2_000);
    const decision = decideIntakeRetry({ attemptCount: 1, error: { statusCode: 429 }, random: () => 0.5 });
    expect(decision).toMatchObject({ retry: true, delayMs: 2_000 });
  });

  it("never retries auth, quota, validation, or safety failures", () => {
    expect(decideIntakeRetry({ attemptCount: 1, error: { statusCode: 401 } })).toMatchObject({ retry: false, reason: "not_retryable_failure" });
    expect(decideIntakeRetry({ attemptCount: 1, error: { statusCode: 402 } })).toMatchObject({ retry: false });
    expect(decideIntakeRetry({ attemptCount: 1, error: { failureCode: "safety_policy_rejected" } })).toMatchObject({ retry: false, failureClass: "safety" });
  });

  it("stops at the attempt budget", () => {
    expect(decideIntakeRetry({ attemptCount: MAX_INTAKE_ATTEMPTS, error: { statusCode: 429 } })).toMatchObject({ retry: false, reason: "attempt_budget_exhausted" });
  });
});

describe("bounded intake projection (Point 2)", () => {
  it("bounds the briefing prompt and records truncation", () => {
    expect(projectIntakeContext("x".repeat(5_000))).toMatchObject({ projectedChars: 2_000, originalChars: 5_000, truncated: true });
    expect(projectIntakeContext("photosynthesis working").truncated).toBe(false);
  });
});
