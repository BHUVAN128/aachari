import { ApprovedScriptSchema, VisualBibleSchema } from "@upcraft/contracts";
import { generateStructuredText } from "@upcraft/providers";
import { saveArtifact, requireContent, validationFeedback } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage, failWithFindings } from "../../usage.ts";
import { validateCaptionSafeArea, validateEntityDescriptionLanguage } from "../../media-qa.ts";
import { getRun } from "../../runs.ts";
import { contextManifest, projectVisualContext } from "../../context.ts";
import { visualBibleJsonSchema } from "../../prompts/visual-bible.ts";
import type { StageContext } from "../context.ts";

type Json = Record<string, unknown>;

/** §6 M5 Visual bible — one project-level look, locked with the script. */
export const runVisualBible = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const script = ApprovedScriptSchema.parse(requireContent(await ctx.getArtifact(runId, "approved-script"), "approved-script"));
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const startedAt = Date.now();
  const visualContext = projectVisualContext(script);
  const snapshotProjection = `Visual profile: ${run.snapshot.visualProfile}\nAspect ratio: ${run.snapshot.aspectRatio}\nAudience: ${run.snapshot.audienceCategory}\n`;
  const route = ctx.route("visual-bible")!;
  const bibleRun = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, { schemaName: "visual_bible", jsonSchema: visualBibleJsonSchema, prompt: `${await validationFeedback(runId, "visual-bible")}Create a locked visual bible from this narration/visual-action projection. ${snapshotProjection}Return schemaVersion "visual-bible/v1", canvasTexture, lineStyle, palette, typography {heading,body,caption}, captionSafeArea {top,right,bottom,left} as fractions, persistentEntities [{id,description}], camera {behavior,transitions}, and prohibitedVisualPatterns. Do not alter narration.\n${JSON.stringify(visualContext)}` }), async (failedRoute, error) => {
    await recordUsage(runId, "visual-bible", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "visual-bible/v1", { projection: "visual-action-projection/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "visual-bible", bibleRun.route.provider, bibleRun.route.model, startedAt, bibleRun.value.usage, "visual-bible/v1", contextManifest("visual-action-projection/v1", [{ role: "visual-context", hash: sha(visualContext), chars: JSON.stringify(visualContext).length, itemCount: visualContext.narration.length }]));
  const bible = VisualBibleSchema.parse(bibleRun.value.value);
  // Zero-token pre-save gate: a bad caption safe area or a localized entity
  // description (which feeds the illustration prompt) fails before anything locks.
  const issues = [
    ...validateCaptionSafeArea(bible.captionSafeArea),
    ...bible.persistentEntities.flatMap((entity) => validateEntityDescriptionLanguage(entity)),
  ];
  if (issues.length) await failWithFindings(runId, "Visual bible QA", issues);
  return saveArtifact({ runId, stage: "visual-bible", role: "visual-bible", schemaVersion: "visual-bible/v1", inputHash: sha(script), content: bible });
};