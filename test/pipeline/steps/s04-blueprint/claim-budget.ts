import type { BlueprintQaIssue } from "./pacing-guard.ts";

/**
 * s04 sandbox — critical-claim budget guard (Flaw 3), test-local until Phase-6
 * promotion.
 *
 * The s03 policy makes critical claims undroppable: every critical claim must be
 * covered by a scene or the run fails. A dense source therefore cannot be
 * "fixed" by pruning — the only safe response is to stop before spending a single
 * planning token and tell the operator the source/duration pair is over budget.
 *
 * `validateClaimBudget` runs before generation (0 tokens) over the verified fact
 * pack; `validateClaimsPerScene` caps how many claims one visual beat may carry.
 */

/** The number of critical claims one minute of lesson can teach without crowding. */
export const CRITICAL_CLAIMS_PER_MINUTE = 8;
/** One visual beat teaches one idea; more claim ids than this means the scene is overloaded. */
export const MAX_CLAIMS_PER_SCENE = 3;

/** Critical-claim allowance for a requested duration, rounded down. */
export const criticalClaimBudget = (durationSeconds: number): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`durationSeconds must be a positive finite number, received ${durationSeconds}`);
  return Math.floor((durationSeconds * CRITICAL_CLAIMS_PER_MINUTE) / 60);
};

/**
 * Pre-generation guard. Exceeding the budget is terminal and visible; because
 * critical claims are undroppable, remediation is to shorten the source-derived
 * critical set or lengthen the lesson — never to prune a critical claim.
 */
export const validateClaimBudget = (params: { criticalClaimCount: number; durationSeconds: number }): BlueprintQaIssue[] => {
  const budget = criticalClaimBudget(params.durationSeconds);
  if (params.criticalClaimCount <= budget) return [];
  return [{
    rule: "blueprint-claim-budget-exceeded",
    evidence: { criticalClaimCount: params.criticalClaimCount, budget, durationSeconds: params.durationSeconds, perMinute: CRITICAL_CLAIMS_PER_MINUTE },
    remediation: `A ${params.durationSeconds}s lesson can teach at most ${budget} critical claims (${CRITICAL_CLAIMS_PER_MINUTE}/minute); critical claims are never dropped, so reduce the critical set or lengthen the lesson.`,
  }];
};

/** Per-scene cap: a scene whose cited claim count exceeds the cap is overcrowded. */
export const validateClaimsPerScene = (params: { scenes: Array<{ id: string; claimIds: string[] }> }): BlueprintQaIssue[] =>
  params.scenes
    .filter((scene) => scene.claimIds.length > MAX_CLAIMS_PER_SCENE)
    .map((scene) => ({
      rule: "blueprint-scene-claim-overcrowded",
      evidence: { sceneId: scene.id, claimCount: scene.claimIds.length, maxClaimsPerScene: MAX_CLAIMS_PER_SCENE },
      remediation: `Split the scene so each visual beat teaches one idea with at most ${MAX_CLAIMS_PER_SCENE} claims.`,
    }));
