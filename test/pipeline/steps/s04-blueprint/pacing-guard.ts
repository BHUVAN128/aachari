/**
 * s04 sandbox — scene-density guard (Flaw 2), test-local until Phase-6 promotion.
 *
 * The blueprint contract only requires `scenes.min(1)`, so a model can return one
 * scene for a ten-minute lesson or sixty two-second scenes for a one-minute
 * lesson and still pass schema validation. This guard turns the governing §4
 * "one teachable idea per beat" rule into a deterministic, zero-token count check
 * against the requested duration.
 *
 * Locked bounds (see NOTES.md): each scene should teach for 6–20 seconds, so the
 * accepted scene count is `minScenes = floor(durationSeconds / 20)` to
 * `maxScenes = ceil(durationSeconds / 6)`. The constants and the exact rounding
 * must be sanity-checked against s05's `pauseMs` budget before promotion constants
 * are frozen.
 */

export type BlueprintQaIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

export const MIN_SCENE_SECONDS = 6;
export const MAX_SCENE_SECONDS = 20;

export type SceneBounds = { minScenes: number; maxScenes: number };

/**
 * Scene-count corridor for a requested duration. `minScenes` guards against a
 * scene running too long; `maxScenes` guards against scenes too short to teach.
 */
export const sceneBoundsFor = (durationSeconds: number): SceneBounds => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`durationSeconds must be a positive finite number, received ${durationSeconds}`);
  return {
    minScenes: Math.floor(durationSeconds / MAX_SCENE_SECONDS),
    maxScenes: Math.ceil(durationSeconds / MIN_SCENE_SECONDS),
  };
};

/** Deterministic gate: a scene count outside the 6–20s corridor blocks the blueprint. */
export const validateSceneDensity = (params: { sceneCount: number; durationSeconds: number }): BlueprintQaIssue[] => {
  const { minScenes, maxScenes } = sceneBoundsFor(params.durationSeconds);
  const issues: BlueprintQaIssue[] = [];

  if (params.sceneCount < minScenes) {
    issues.push({
      rule: "blueprint-scene-density-low",
      evidence: { sceneCount: params.sceneCount, minScenes, maxScenes, durationSeconds: params.durationSeconds, maxSceneSeconds: MAX_SCENE_SECONDS },
      remediation: `Add scenes so a ${params.durationSeconds}s lesson has at least ${minScenes} scene(s), each no longer than ${MAX_SCENE_SECONDS}s.`,
    });
  }
  if (params.sceneCount > maxScenes) {
    issues.push({
      rule: "blueprint-scene-density-high",
      evidence: { sceneCount: params.sceneCount, minScenes, maxScenes, durationSeconds: params.durationSeconds, minSceneSeconds: MIN_SCENE_SECONDS },
      remediation: `Merge scenes so a ${params.durationSeconds}s lesson has at most ${maxScenes} scene(s), each at least ${MIN_SCENE_SECONDS}s.`,
    });
  }

  return issues;
};
