import { BlueprintV2Schema, VerifiedFactPackSchema, type Blueprint } from "@upcraft/contracts";
import { generateStructuredText } from "@upcraft/providers";
import { saveArtifact, requireContent, validationFeedback } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage, failWithFindings } from "../../usage.ts";
import { getRun } from "../../runs.ts";
import {
  blueprintInputHash,
  validateBlueprint,
  validateClaimBudget,
  validateClaimsPerScene,
  validateSceneDensity,
  validateVisualBeats,
  type BlueprintIssue,
} from "../../blueprint-qa.ts";
import { BlueprintQaRejectionError, buildBlueprintRepairPrompt, runBoundedBlueprintRepairLoop, type BlueprintCorrection } from "../../blueprint-repair.ts";
import { contextManifest } from "../../context.ts";
import { blueprintJsonSchema, blueprintPromptRules } from "../../prompts/blueprint.ts";
import type { StageContext } from "../context.ts";

type Json = Record<string, unknown>;

/**
 * §4 M3 Lesson blueprint — learning objective, scene arc, and visual beats.
 *
 * A 0-token pre-generation guard rejects an over-budget critical-claim set before
 * any planning call (critical claims are undroppable, so pruning is not a fix).
 * Generation and deterministic QA then run inside a bounded repair loop (max 3);
 * a surviving failure is terminal and visible. The saved artifact's input hash
 * binds the verified fact pack and the frozen snapshot.
 */
export const runBlueprint = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const factPack = requireContent(await ctx.getArtifact(runId, "verified-fact-pack"), "verified-fact-pack");
  const parsedFactPack = VerifiedFactPackSchema.parse(factPack);
  const criticalClaimIds = parsedFactPack.claims.filter((claim) => claim.critical).map((claim) => claim.id);
  const allowedClaimIds = new Set(parsedFactPack.claims.map((claim) => claim.id));
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");

  const budgetIssues = validateClaimBudget({ criticalClaimCount: criticalClaimIds.length, durationSeconds: run.snapshot.durationSeconds });
  if (budgetIssues.length) await failWithFindings(runId, "Blueprint claim budget", budgetIssues);

  const route = ctx.route("blueprint")!;
  const snapshotProjection = `Learner level: ${run.snapshot.learningLevel}\nAudience: ${run.snapshot.audienceCategory}\nLanguage: ${run.snapshot.language}\nDuration budget: ${run.snapshot.durationSeconds}s\n`;
  const projectionHash = sha(factPack);
  const inputHash = blueprintInputHash(factPack, run.snapshotHash);
  let lastBlueprint: Blueprint | null = null;

  const generate = async (correction: BlueprintCorrection | null): Promise<Blueprint> => {
    const startedAt = Date.now();
    const promptVersion = correction ? "blueprint-repair/v1" : "blueprint/v3";
    const task = `${await validationFeedback(runId, "blueprint")}Create an educational lesson blueprint for ${run.title}. ${snapshotProjection}Return schemaVersion "lesson-blueprint/v2", objective, prerequisites, hook, recap, optional knowledgeCheck {question,options,answerIndex}, and scenes [{id,order,purpose,claimIds,visualBeat}]. Each scene must have one meaningful visual beat, strictly increasing order, at least one cited claim ID, and together the scenes must cover every critical claim. Do not invent claims. ${blueprintPromptRules}`;
    const prompt = correction && lastBlueprint
      ? `${buildBlueprintRepairPrompt({ correction, previous: lastBlueprint })}\n${JSON.stringify(factPack)}`
      : `${task}\n${JSON.stringify(factPack)}`;

    const generated = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, { schemaName: "lesson_blueprint", jsonSchema: blueprintJsonSchema, prompt }), async (failedRoute, error) => {
      await recordUsage(runId, "blueprint", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, promptVersion, { projection: "verified-fact-catalog/v1" }, "failed", error.code);
    });
    await recordUsage(runId, "blueprint", generated.route.provider, generated.route.model, startedAt, generated.value.usage, promptVersion, contextManifest("verified-fact-catalog/v1", [{ role: "verified-fact-pack", hash: projectionHash, chars: JSON.stringify(factPack).length, itemCount: parsedFactPack.claims.length }]));
    const blueprint = BlueprintV2Schema.parse(generated.value.value);
    lastBlueprint = blueprint;
    return blueprint;
  };

  const verify = (blueprint: Blueprint): void => {
    const issues: BlueprintIssue[] = [
      ...validateBlueprint({ blueprint, criticalClaimIds, allowedClaimIds }),
      ...validateSceneDensity({ sceneCount: blueprint.scenes.length, durationSeconds: run.snapshot.durationSeconds }),
      ...validateClaimsPerScene({ scenes: blueprint.scenes }),
      ...validateVisualBeats({ scenes: blueprint.scenes }),
    ];
    if (issues.length) throw new BlueprintQaRejectionError({ issues });
  };

  const loop = await runBoundedBlueprintRepairLoop({ generate, verify });
  const blueprint = loop.value;
  return saveArtifact({ runId, stage: "blueprint", role: "lesson-blueprint", schemaVersion: blueprint.schemaVersion, inputHash, content: blueprint });
};
