import type { Blueprint } from "@upcraft/contracts";

/**
 * Deterministic Stage 3 blueprint validators from `docs/video-generation-process.md` §4.
 *
 * The doc requires the blueprint to carry a measurable learning objective,
 * learner prerequisites, a hook, the explanation arc (scenes), a recap, and an
 * optional knowledge-check, and to be validated for learning-objective coverage,
 * prerequisites, scene order, and claim references before it is locked. These
 * checks are pure and cost zero tokens so a malformed blueprint can never be
 * promoted by the model's own claim that it is valid.
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
