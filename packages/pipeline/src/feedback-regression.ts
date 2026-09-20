import { desc } from "drizzle-orm";
import { getDb, viewerOutcomes } from "@upcraft/db";
import type { ViewerOutcomeInput } from "@upcraft/contracts";
import { fromMillionths } from "./outcomes.ts";

/**
 * Feedback → regression closed loop from `docs/video-generation-process.md` §12:
 * "Feed viewer retention, quiz results, and reviewer feedback into the regression
 * suite." A weak-but-measured outcome becomes a typed regression fixture that a
 * reviewer can replay against a candidate model/prompt change.
 *
 * The weak-outcome policy is pure and versioned so the same measurement always
 * produces the same fixture, independent of the database.
 */
export type RegressionFixture = {
  schemaVersion: "regression-fixture/v1";
  runId: string;
  kind: ViewerOutcomeInput["kind"];
  segment?: string;
  metric: string;
  value: number;
  threshold: number;
  direction: "below" | "above";
  reason: string;
  capturedAt: string;
};

export type WeakOutcomeRule = {
  kind: ViewerOutcomeInput["kind"];
  direction: "below" | "above";
  threshold: number;
  reason: string;
};

/**
 * Outcome directions differ: low retention/quiz/feedback scores are weak, while
 * a high scene-drop rate is weak. Rewatch has no weak direction and is retained
 * for context only.
 */
export const WEAK_OUTCOME_RULES: WeakOutcomeRule[] = [
  { kind: "retention", direction: "below", threshold: 0.7, reason: "intro-retention-below-target" },
  { kind: "scene-drop", direction: "above", threshold: 0.3, reason: "scene-drop-above-target" },
  { kind: "quiz", direction: "below", threshold: 0.6, reason: "quiz-score-below-target" },
  { kind: "teacher-feedback", direction: "below", threshold: 0.6, reason: "teacher-feedback-below-target" },
  { kind: "reviewer-feedback", direction: "below", threshold: 0.6, reason: "reviewer-feedback-below-target" },
];

export const classifyWeakOutcome = (outcome: Pick<ViewerOutcomeInput, "kind" | "value">): { rule: WeakOutcomeRule } | undefined => {
  const rule = WEAK_OUTCOME_RULES.find((candidate) => candidate.kind === outcome.kind);
  if (!rule) return undefined;
  const weak = rule.direction === "below" ? outcome.value < rule.threshold : outcome.value > rule.threshold;
  return weak ? { rule } : undefined;
};

export const buildRegressionFixtures = (outcomes: Array<{
  runId: string;
  kind: ViewerOutcomeInput["kind"];
  segment?: string | null;
  metric: string;
  value: number;
  capturedAt: string;
}>): RegressionFixture[] =>
  outcomes.flatMap((outcome) => {
    const classified = classifyWeakOutcome({ kind: outcome.kind, value: outcome.value });
    if (!classified) return [];
    return [{
      schemaVersion: "regression-fixture/v1" as const,
      runId: outcome.runId,
      kind: outcome.kind,
      ...(outcome.segment ? { segment: outcome.segment } : {}),
      metric: outcome.metric,
      value: outcome.value,
      threshold: classified.rule.threshold,
      direction: classified.rule.direction,
      reason: classified.rule.reason,
      capturedAt: outcome.capturedAt,
    }];
  });

/** Reads persisted outcomes and returns the weak ones as regression fixtures. */
export const collectRegressionFixtures = async (limit = 500): Promise<RegressionFixture[]> => {
  const db = getDb();
  const rows = await db.select().from(viewerOutcomes).orderBy(desc(viewerOutcomes.createdAt)).limit(limit);
  return buildRegressionFixtures(rows.map((row) => ({
    runId: row.runId,
    kind: row.kind as ViewerOutcomeInput["kind"],
    segment: row.segment,
    metric: row.metric,
    value: fromMillionths(row.value),
    capturedAt: row.createdAt.toISOString(),
  })));
};
