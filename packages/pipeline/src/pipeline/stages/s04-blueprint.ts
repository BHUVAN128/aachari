import { BlueprintV2Schema, VerifiedFactPackSchema } from "@upcraft/contracts";
import { generateStructuredText } from "@upcraft/providers";
import { saveArtifact, requireContent, validationFeedback } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage, failWithFindings } from "../../usage.ts";
import { getRun } from "../../runs.ts";
import { validateBlueprint } from "../../blueprint-qa.ts";
import { contextManifest } from "../../context.ts";
import { blueprintJsonSchema } from "../../prompts/blueprint.ts";
import type { StageContext } from "../context.ts";

type Json = Record<string, unknown>;

/** §4 M3 Lesson blueprint — learning objective, scene arc, and visual beats. */
export const runBlueprint = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const factPack = requireContent(await ctx.getArtifact(runId, "verified-fact-pack"), "verified-fact-pack");
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const startedAt = Date.now();
  const route = ctx.route("blueprint")!;
  const snapshotProjection = `Learner level: ${run.snapshot.learningLevel}\nAudience: ${run.snapshot.audienceCategory}\nLanguage: ${run.snapshot.language}\nDuration budget: ${run.snapshot.durationSeconds}s\n`;
  const generated = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, { schemaName: "lesson_blueprint", jsonSchema: blueprintJsonSchema, prompt: `${await validationFeedback(runId, "blueprint")}Create an educational lesson blueprint for ${run.title}. ${snapshotProjection}Return schemaVersion "lesson-blueprint/v2", objective, prerequisites, hook, recap, optional knowledgeCheck {question,options,answerIndex}, and scenes [{id,order,purpose,claimIds,visualBeat}]. Each scene must have one meaningful visual beat, strictly increasing order, at least one cited claim ID, and together the scenes must cover every critical claim. Do not invent claims.\n${JSON.stringify(factPack)}` }), async (failedRoute, error) => {
    await recordUsage(runId, "blueprint", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "blueprint/v2", { projection: "verified-fact-catalog/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "blueprint", generated.route.provider, generated.route.model, startedAt, generated.value.usage, "blueprint/v2", contextManifest("verified-fact-catalog/v1", [{ role: "verified-fact-pack", hash: sha(factPack), chars: JSON.stringify(factPack).length, itemCount: VerifiedFactPackSchema.parse(factPack).claims.length }]));
  const blueprint = BlueprintV2Schema.parse(generated.value.value);
  const parsedFactPack = VerifiedFactPackSchema.parse(requireContent(await ctx.getArtifact(runId, "verified-fact-pack"), "verified-fact-pack"));
  const allowedClaimIds = new Set(parsedFactPack.claims.map((claim) => claim.id));
  const blueprintIssues = validateBlueprint({ blueprint, criticalClaimIds: parsedFactPack.claims.filter((claim) => claim.critical).map((claim) => claim.id), allowedClaimIds });
  if (blueprintIssues.length) await failWithFindings(runId, "Blueprint QA", blueprintIssues);
  return saveArtifact({ runId, stage: "blueprint", role: "lesson-blueprint", schemaVersion: blueprint.schemaVersion, inputHash: sha(factPack), content: blueprint });
};