import { createHash } from "node:crypto";
import type { Blueprint } from "@upcraft/contracts";

/**
 * Deterministic Stage 3 blueprint validators from `docs/video-generation-process.md` §4.
 *
 * The doc requires the blueprint to carry a measurable learning objective,
 * learner prerequisites, a hook, the explanation arc (scenes), a recap, and an
 * optional knowledge-check, and to be validated for learning-objective coverage,
 * prerequisites, scene order, and claim references before it is locked. §4 also
 * requires a bounded scene count for the requested duration, a critical-claim
 * budget, and a meaningful English visual beat. These checks are pure and cost
 * zero tokens so a malformed blueprint can never be promoted by the model's own
 * claim that it is valid.
 */
export type BlueprintIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

const isNonEmptyText = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Validates one locked blueprint against the verified fact pack. Every finding
 * names the failed rule, the evidence, and the remediation, matching the QA
 * finding contract used elsewhere in the pipeline.
 */
export const validateBlueprint = (params: {
  blueprint: Blueprint;
  /** Claim IDs that must each be covered by at least one scene. */
  criticalClaimIds: string[];
  /** All claim IDs locked in the verified fact pack. */
  allowedClaimIds: Set<string>;
}): BlueprintIssue[] => {
  const { blueprint } = params;
  const issues: BlueprintIssue[] = [];

  if (!isNonEmptyText(blueprint.objective)) {
    issues.push({ rule: "blueprint-objective-missing", evidence: {}, remediation: "Provide one measurable learning objective from the verified fact pack." });
  }
  if (!blueprint.prerequisites.length || blueprint.prerequisites.some((entry) => !isNonEmptyText(entry))) {
    issues.push({ rule: "blueprint-prerequisites-missing", evidence: { prerequisites: blueprint.prerequisites }, remediation: "State the learner prerequisites (at minimum 'none required' for an entry lesson)." });
  }
  if (!isNonEmptyText(blueprint.hook)) {
    issues.push({ rule: "blueprint-hook-missing", evidence: {}, remediation: "Add an opening hook that motivates the objective." });
  }
  if (!isNonEmptyText(blueprint.recap)) {
    issues.push({ rule: "blueprint-recap-missing", evidence: {}, remediation: "Add a recap that restates the objective-relevant takeaways." });
  }
  if (!blueprint.scenes.length) {
    issues.push({ rule: "blueprint-scenes-missing", evidence: {}, remediation: "Divide the explanation into at least one scene with a single teachable idea." });
  }
  if (blueprint.knowledgeCheck) {
    const { options, answerIndex } = blueprint.knowledgeCheck;
    if (answerIndex >= options.length) {
      issues.push({ rule: "blueprint-knowledge-check-answer", evidence: { answerIndex, options: options.length }, remediation: "Point the knowledge-check answer at one of its declared options." });
    }
  }

  const seenSceneIds = new Set<string>();
  let previousOrder = -1;
  for (const [index, scene] of blueprint.scenes.entries()) {
    if (seenSceneIds.has(scene.id)) {
      issues.push({ rule: "blueprint-scene-id-duplicate", evidence: { sceneId: scene.id }, remediation: "Give every scene a unique stable identity." });
    }
    seenSceneIds.add(scene.id);
    if (scene.order <= previousOrder) {
      issues.push({ rule: "blueprint-scene-order", evidence: { sceneId: scene.id, order: scene.order, previousOrder }, remediation: "Scene order must strictly increase so the explanation arc is deterministic." });
    }
    previousOrder = scene.order;
    if (!scene.claimIds.length) {
      issues.push({ rule: "blueprint-scene-claim-missing", evidence: { sceneId: scene.id, index }, remediation: "Every scene must reference at least one verified claim; never add an unsupported scene." });
    }
    const unknown = scene.claimIds.filter((claimId) => !params.allowedClaimIds.has(claimId));
    if (unknown.length) {
      issues.push({ rule: "blueprint-claim-reference-invalid", evidence: { sceneId: scene.id, unknown }, remediation: "Reference only claim IDs locked in the verified fact pack." });
    }
  }

  const coveredClaimIds = new Set(blueprint.scenes.flatMap((scene) => scene.claimIds));
  const uncoveredCritical = params.criticalClaimIds.filter((claimId) => !coveredClaimIds.has(claimId));
  if (uncoveredCritical.length) {
    issues.push({ rule: "blueprint-objective-coverage", evidence: { uncoveredCritical }, remediation: "Add a scene that teaches every critical claim, or drop the claim from the fact pack." });
  }

  return issues;
};

// --- Scene density (6–20s per scene) ---

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
export const validateSceneDensity = (params: { sceneCount: number; durationSeconds: number }): BlueprintIssue[] => {
  const { minScenes, maxScenes } = sceneBoundsFor(params.durationSeconds);
  const issues: BlueprintIssue[] = [];

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

// --- Critical-claim budget and per-scene claim load ---

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
 * Pre-generation guard. Critical claims are undroppable, so exceeding the budget
 * is terminal and visible before any planning token is spent; remediation is to
 * reduce the critical set or lengthen the lesson, never to prune a critical claim.
 */
export const validateClaimBudget = (params: { criticalClaimCount: number; durationSeconds: number }): BlueprintIssue[] => {
  const budget = criticalClaimBudget(params.durationSeconds);
  if (params.criticalClaimCount <= budget) return [];
  return [{
    rule: "blueprint-claim-budget-exceeded",
    evidence: { criticalClaimCount: params.criticalClaimCount, budget, durationSeconds: params.durationSeconds, perMinute: CRITICAL_CLAIMS_PER_MINUTE },
    remediation: `A ${params.durationSeconds}s lesson can teach at most ${budget} critical claims (${CRITICAL_CLAIMS_PER_MINUTE}/minute); critical claims are never dropped, so reduce the critical set or lengthen the lesson.`,
  }];
};

/** Per-scene cap: a scene whose cited claim count exceeds the cap is overcrowded. */
export const validateClaimsPerScene = (params: { scenes: Array<{ id: string; claimIds: string[] }> }): BlueprintIssue[] =>
  params.scenes
    .filter((scene) => scene.claimIds.length > MAX_CLAIMS_PER_SCENE)
    .map((scene) => ({
      rule: "blueprint-scene-claim-overcrowded",
      evidence: { sceneId: scene.id, claimCount: scene.claimIds.length, maxClaimsPerScene: MAX_CLAIMS_PER_SCENE },
      remediation: `Split the scene so each visual beat teaches one idea with at most ${MAX_CLAIMS_PER_SCENE} claims.`,
    }));

// --- Visual-beat validation (meaningful, directive, English) ---

export const MIN_VISUAL_BEAT_CHARS = 20;
export const MIN_VISUAL_BEAT_WORDS = 4;

/**
 * Visual-direction vocabulary. A visual beat must contain at least one word that
 * tells the renderer what changes on the canvas, so a purely descriptive sentence
 * is rejected instead of silently becoming a static slide.
 */
export const VISUAL_DIRECTION_KEYWORDS = [
  "reveal", "draw", "animate", "zoom", "highlight", "pan", "build", "assemble",
  "trace", "label", "show", "display", "illustrate", "map", "compare", "split",
  "explode", "rotate", "transition", "overlay", "underline", "circle", "arrow",
  "graph", "chart", "diagram", "morph", "fade", "focus", "frame", "sequence",
  "sketch", "outline", "magnify", "point", "connect", "stack", "layer", "timeline",
  "walk", "step", "spin", "tilt", "slide", "mark", "annotate", "model", "cut",
  "grow", "shrink", "pulse", "glide",
] as const;

const KEYWORD_PATTERN = new RegExp(`\\b(${VISUAL_DIRECTION_KEYWORDS.join("|")})\\b`, "i");

/**
 * Non-Latin script detection for the localization heuristic. Greek is deliberately
 * excluded so legitimate scientific beats (for example "label the β-carbon") are
 * not false positives. A Latin-script target (es/de) cannot be detected this way;
 * the prompt rule is the primary enforcement there.
 */
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

export const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

export const isNonEnglishScript = (value: string): boolean => NON_LATIN_SCRIPT.test(value);

export const hasVisualDirectionKeyword = (value: string): boolean => KEYWORD_PATTERN.test(value);

/**
 * Deterministic gate for one visual beat. Precedence: a non-Latin script is
 * reported as `localized` first, then too-short beats as `vague`, then beats with
 * no canvas-direction word as `nonDirective`.
 */
export const validateVisualBeat = (visualBeat: string): BlueprintIssue[] => {
  if (isNonEnglishScript(visualBeat)) {
    return [{
      rule: "blueprint-visual-beat-localized",
      evidence: { visualBeat, detectedScript: "non-latin" },
      remediation: "Rewrite the visualBeat in English; only objective, hook, recap, purpose, and narration use the target language.",
    }];
  }

  const chars = visualBeat.trim().length;
  const words = countWords(visualBeat);
  if (chars < MIN_VISUAL_BEAT_CHARS || words < MIN_VISUAL_BEAT_WORDS) {
    return [{
      rule: "blueprint-visual-beat-vague",
      evidence: { visualBeat, chars, words, minChars: MIN_VISUAL_BEAT_CHARS, minWords: MIN_VISUAL_BEAT_WORDS },
      remediation: `Describe the canvas change in at least ${MIN_VISUAL_BEAT_WORDS} words and ${MIN_VISUAL_BEAT_CHARS} characters.`,
    }];
  }

  if (!hasVisualDirectionKeyword(visualBeat)) {
    return [{
      rule: "blueprint-visual-beat-nonDirective",
      evidence: { visualBeat, keywords: [...VISUAL_DIRECTION_KEYWORDS] },
      remediation: "Include a visual-direction word (for example reveal, draw, trace, label, compare) so the renderer knows what changes on the canvas.",
    }];
  }

  return [];
};

/** Applies the single-beat gate to every scene in a blueprint. */
export const validateVisualBeats = (params: { scenes: Array<{ id: string; visualBeat: string }> }): BlueprintIssue[] =>
  params.scenes.flatMap((scene) => validateVisualBeat(scene.visualBeat).map((issue) => ({ ...issue, evidence: { ...issue.evidence, sceneId: scene.id } })));

// --- Composite input hash ---

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The blueprint's true generation input: the verified fact pack plus the frozen
 * snapshot. Binding both into the saved artifact's `inputHash` keeps replay
 * idempotence and any future content-addressed cache correct by construction.
 */
export const blueprintInputHash = (factPack: unknown, snapshotHash: string): string => sha([factPack, snapshotHash]);
