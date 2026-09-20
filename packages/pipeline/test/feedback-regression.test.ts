import { describe, expect, it } from "vitest";
import { buildRegressionFixtures, classifyWeakOutcome, WEAK_OUTCOME_RULES } from "../src/feedback-regression.ts";

const outcome = (overrides: Partial<Parameters<typeof buildRegressionFixtures>[0][number]> = {}) => ({
  runId: "11111111-1111-4111-8111-111111111111",
  kind: "retention" as const,
  metric: "intro-retention",
  value: 0.5,
  capturedAt: "2026-09-20T00:00:00.000Z",
  ...overrides,
});

describe("weak-outcome classification", () => {
  it("flags low retention/quiz/feedback and high scene drops", () => {
    expect(classifyWeakOutcome({ kind: "retention", value: 0.5 })?.rule.reason).toBe("intro-retention-below-target");
    expect(classifyWeakOutcome({ kind: "scene-drop", value: 0.6 })?.rule.reason).toBe("scene-drop-above-target");
    expect(classifyWeakOutcome({ kind: "quiz", value: 0.4 })?.rule.reason).toBe("quiz-score-below-target");
    expect(classifyWeakOutcome({ kind: "reviewer-feedback", value: 0.2 })?.rule.reason).toBe("reviewer-feedback-below-target");
  });

  it("does not flag strong outcomes or rewatch, which has no weak direction", () => {
    expect(classifyWeakOutcome({ kind: "retention", value: 0.9 })).toBeUndefined();
    expect(classifyWeakOutcome({ kind: "scene-drop", value: 0.1 })).toBeUndefined();
    expect(classifyWeakOutcome({ kind: "rewatch", value: 0 })).toBeUndefined();
  });

  it("keeps every rule direction and threshold explicit", () => {
    expect(WEAK_OUTCOME_RULES.every((rule) => ["below", "above"].includes(rule.direction) && Number.isFinite(rule.threshold))).toBe(true);
  });
});

describe("regression fixture generation", () => {
  it("turns only weak outcomes into typed, reviewable fixtures", () => {
    const fixtures = buildRegressionFixtures([
      outcome(),
      outcome({ kind: "retention", value: 0.95, metric: "intro-retention-strong" }),
      outcome({ kind: "scene-drop", value: 0.45, metric: "drop-at-2s", segment: "scene-2" }),
    ]);
    expect(fixtures.map((fixture) => fixture.metric)).toEqual(["intro-retention", "drop-at-2s"]);
    expect(fixtures[1]).toMatchObject({ schemaVersion: "regression-fixture/v1", kind: "scene-drop", direction: "above", threshold: 0.3, segment: "scene-2" });
  });

  it("preserves the measured value and source run for later comparison", () => {
    const [fixture] = buildRegressionFixtures([outcome({ kind: "quiz", value: 0.25 })]);
    expect(fixture).toMatchObject({ value: 0.25, runId: "11111111-1111-4111-8111-111111111111", capturedAt: "2026-09-20T00:00:00.000Z" });
  });
});