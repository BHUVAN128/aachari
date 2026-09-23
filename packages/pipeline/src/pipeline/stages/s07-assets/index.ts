import { ApprovedScriptSchema, BlueprintSchema, VerifiedFactPackSchema, VisualBibleSchema } from "@upcraft/contracts";
import { saveArtifact, requireContent } from "../../../artifacts/store.ts";
import { sha } from "../../../artifacts/hashing.ts";
import { getRun } from "../../../runs.ts";
import { buildSceneAssetBrief, buildSceneAssetBriefs, buildSceneDirections, buildScenePlans } from "../../../planning.ts";
import type { DiagramPalette } from "../../../diagram-qa.ts";
import type { StageContext } from "../../context.ts";
import { sceneDiagramArea } from "../../scene-area.ts";
import { renderDiagrams } from "./diagrams.ts";
import { renderIllustrations } from "./illustrations.ts";
import { buildDeferredSoundPlan } from "./sound-plan.ts";

/**
 * §7 M6 Asset production — orchestrates the three independent asset producers
 * after the approved script and visual bible lock:
 *   1. deterministic typed SVG diagrams (factual meaning),
 *   2. optional PNG illustrations with recorded omissions,
 *   3. the deferred deterministic sound plan (retained, not a release gate).
 *
 * The call order (plans → briefs → sound plan → diagrams+anchors →
 * illustrations) is preserved exactly from the original `runAssets` so
 * persisted provenance and persisted-media behavior are unchanged.
 */
export const runAssets = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [scriptArtifact, bibleArtifact, blueprintArtifact, factArtifact, run] = await Promise.all([
    ctx.getArtifact(runId, "approved-script"), ctx.getArtifact(runId, "visual-bible"),
    ctx.getArtifact(runId, "lesson-blueprint"), ctx.getArtifact(runId, "verified-fact-pack"), getRun(runId),
  ]);
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const bible = VisualBibleSchema.parse(requireContent(bibleArtifact, "visual-bible"));
  const blueprint = BlueprintSchema.parse(requireContent(blueprintArtifact, "lesson-blueprint"));
  const factPack = VerifiedFactPackSchema.parse(requireContent(factArtifact, "verified-fact-pack"));
  if (!run) throw new Error("Run not found");
  const inputHash = sha([script, bible, blueprint, factPack]);
  const existing = await ctx.getArtifact(runId, "selected-assets");
  if (existing?.inputHash === inputHash) return existing;

  const directions = buildSceneDirections({ blueprint, script, factPack });
  const planned = directions.map((direction) => ({ direction, ...buildSceneAssetBrief(direction, { persistentEntities: bible.persistentEntities }) }));
  const plans = buildScenePlans(planned.map((entry) => entry.model));
  const briefs = buildSceneAssetBriefs(planned.map((entry) => entry.brief));
  const soundPlan = buildDeferredSoundPlan(directions);
  const scenePlanArtifact = await saveArtifact({ runId, stage: "assets", role: "scene-plans", schemaVersion: plans.schemaVersion, inputHash: sha(blueprint), content: plans, provenance: { provider: "deterministic", model: "scene-plan/v1" } });
  const briefArtifact = await saveArtifact({ runId, stage: "assets", role: "scene-asset-briefs", schemaVersion: briefs.schemaVersion, inputHash: sha([blueprint, factPack]), content: briefs, provenance: { provider: "deterministic", model: "scene-asset-brief/v1" } });
  const soundPlanArtifact = await saveArtifact({ runId, stage: "assets", role: "sound-plan", schemaVersion: soundPlan.schemaVersion, inputHash: sha([blueprint, script]), content: soundPlan, provenance: { provider: "deterministic", model: "sound-plan/v1" } });

  const canvas = run.snapshot.aspectRatio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const area = sceneDiagramArea(canvas);
  const allowedClaimIds = new Set(factPack.claims.map((claim) => claim.id));
  const lockedTexts = [factPack.claims.map((claim) => claim.text).join("\n"), script.narration.map((line) => `${line.text} ${line.visualAction}`).join("\n"), blueprint.scenes.map((scene) => `${scene.purpose} ${scene.visualBeat}`).join("\n")];
  const palette: DiagramPalette = { canvasTexture: bible.canvasTexture, palette: bible.palette, typography: { heading: bible.typography.heading, body: bible.typography.body } };

  const assets = await renderDiagrams({
    runId, planned, canvas, area, lockedTexts, allowedClaimIds, palette,
    scenePlanArtifactId: scenePlanArtifact.id, briefArtifactId: briefArtifact.id, script, bible,
  });

  const illustrationDecisions = await renderIllustrations({
    runId, stage: "assets", domain: run.domain, planned, bible,
    briefArtifactId: briefArtifact.id, briefs, briefArtifactSha256: briefArtifact.sha256,
    illustrationRoute: ctx.route("assets"),
  });
  const illustrationAssetIds = illustrationDecisions.flatMap((decision) => (decision.assetId ? [decision.assetId] : []));
  const content = {
    assetIds: [...assets.map((asset) => asset.id), ...illustrationAssetIds],
    composition: "typed-scene-svg",
    visualBibleHash: sha(bible),
    scenePlanArtifactId: scenePlanArtifact.id,
    sceneAssetBriefArtifactId: briefArtifact.id,
    soundPlanArtifactId: soundPlanArtifact.id,
    diagramKinds: planned.map(({ direction, model }) => ({ sceneId: direction.sceneId, kind: model.kind, labels: model.labels })),
    // Persist the typed models so the independent visual QA branch can
    // re-render and re-validate geometry/vocabulary from locked evidence.
    diagramModels: planned.map(({ model }) => model),
    illustrationDecisions,
  };
  return saveArtifact({ runId, stage: "assets", role: "selected-assets", schemaVersion: "selected-assets/v1", inputHash, content });
};