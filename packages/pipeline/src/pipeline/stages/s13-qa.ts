import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { ApprovedScriptSchema, ConsolidatedReviewSchema, DiagramModelSchema, ProjectManifestSchema, ResolvedLayoutSchema, VerifiedFactPackSchema, VisualBibleSchema, type WordTiming } from "@upcraft/contracts";
import { getDb, mediaAssets, qaFindings } from "@upcraft/db";
import { getPrivateObject, resolveModelRoute, reviewWithRoute } from "@upcraft/providers";
import { probeAudioDurationMs, probeLoudness, probeMedia, type MediaProbe } from "@upcraft/compositor";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage } from "../../usage.ts";
import { getRun } from "../../runs.ts";
import { curatedDomainTerms } from "../../media-qa.ts";
import { audioRenderQa, consolidatedReviewQa, convergeQaTiers, deterministicQa, spatialQa, structuralQa, visualQa, type QaTierResult } from "../../qa-branches.ts";
import { canonicalNarrationText, contextManifest } from "../../context.ts";
import type { DiagramPalette } from "../../diagram-qa.ts";
import type { StageContext } from "../context.ts";
import { sceneDiagramArea } from "../scene-area.ts";

const ZERO_MEDIA_PROBE: MediaProbe = { durationMs: 0, width: 0, height: 0, fps: 0, videoCodec: "", audioCodec: null, hasAudio: false };

/** Probes a stored private object through a temp file; nothing trusts the request. */
const probePrivateMedia = async <T>(params: { objectKey: string; fileName: string; probe: (path: string) => Promise<T> }): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "upcraft-qa-"));
  try {
    const path = join(dir, params.fileName);
    await writeFile(path, await getPrivateObject(params.objectKey));
    return await params.probe(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * §11 M10 Tiered QA. Tier A is deterministic and zero-token; Tier B is exactly
 * one consolidated, separately routed review started before Tier A so its network
 * round-trip overlaps the deterministic checks. Approval may be scheduled only
 * when both tiers report and no critical finding remains.
 */
export const runQa = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [captionArtifact, manifestArtifact, previewArtifact, factArtifact, scriptArtifact, layoutArtifact, assets, run, selectedAssetsArtifact, blueprintArtifact, bibleArtifact] = await Promise.all([
    ctx.getArtifact(runId, "caption-timings"), ctx.getArtifact(runId, "project-manifest"), ctx.getArtifact(runId, "preview-render"),
    ctx.getArtifact(runId, "verified-fact-pack"), ctx.getArtifact(runId, "approved-script"), ctx.getArtifact(runId, "resolved-layout"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
    getRun(runId), ctx.getArtifact(runId, "selected-assets"),
    ctx.getArtifact(runId, "lesson-blueprint"), ctx.getArtifact(runId, "visual-bible"),
  ]);
  const captions = requireContent<{ words: WordTiming[]; cues: Array<{ wordIndexes: number[] }> }>(captionArtifact, "caption-timings");
  const manifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const bible = VisualBibleSchema.parse(requireContent(bibleArtifact, "visual-bible"));
  const requiredArtifacts: Array<[string, unknown]> = [["verified-fact-pack", factArtifact], ["approved-script", scriptArtifact], ["resolved-layout", layoutArtifact], ["project-manifest", manifestArtifact], ["lesson-blueprint", blueprintArtifact], ["visual-bible", bibleArtifact]];
  const missingArtifacts = requiredArtifacts.filter(([, artifact]) => !artifact).map(([role]) => role);
  const scriptSceneCount = new Set(script.narration.map((line) => line.sceneId)).size;

  const selectedAssetsContent = selectedAssetsArtifact?.content as { diagramKinds?: Array<{ labels?: string[] }>; diagramModels?: unknown[] } | undefined;
  const diagramLabels = selectedAssetsContent?.diagramKinds?.flatMap((entry) => entry.labels ?? []) ?? [];
  const factPack = factArtifact ? VerifiedFactPackSchema.parse(requireContent(factArtifact, "verified-fact-pack")) : undefined;
  const blueprint = blueprintArtifact ? requireContent<{ objective: string; scenes: Array<{ id: string; purpose: string; visualBeat: string }> }>(blueprintArtifact, "lesson-blueprint") : undefined;
  const diagramModels = (selectedAssetsContent?.diagramModels ?? []).flatMap((model) => {
    const parsed = DiagramModelSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
  const layoutBundle = layoutArtifact ? requireContent<{ canvas: { width: number; height: number }; layouts: unknown[] }>(layoutArtifact, "resolved-layout") : undefined;
  const layouts = (layoutBundle?.layouts ?? []).map((layout) => ResolvedLayoutSchema.parse(layout));

  // Narration and preview are re-probed from their stored bytes so the audio and
  // render-integrity findings cannot be satisfied by the pre-render request.
  const narration = assets.find((asset) => asset.role === "narration");
  if (!narration) throw new Error("QA requires the persisted narration asset");
  const narrationDurationMs = await probePrivateMedia({ objectKey: narration.objectKey, fileName: "narration.mp3", probe: probeAudioDurationMs });
  const narrationLoudness = await probePrivateMedia({ objectKey: narration.objectKey, fileName: "narration.mp3", probe: probeLoudness });
  const curatedTerms = curatedDomainTerms([...(factPack?.claims.map((claim) => claim.text) ?? []), canonicalNarrationText(script)]);
  const previewProvenance = previewArtifact ? requireContent<{ objectKey?: string }>(previewArtifact, "preview-render") : undefined;
  const previewProbe = previewProvenance?.objectKey
    ? await probePrivateMedia({ objectKey: previewProvenance.objectKey, fileName: "preview.mp4", probe: probeMedia })
    : ZERO_MEDIA_PROBE;

  const canvas = manifest.canvas;
  const area = sceneDiagramArea(canvas);
  const palette: DiagramPalette = { canvasTexture: bible.canvasTexture, palette: bible.palette, typography: { heading: bible.typography.heading, body: bible.typography.body } };
  const lockedTexts = [script.narration.map((line) => `${line.text} ${line.visualAction}`).join("\n"), ...(factPack && blueprint ? [factPack.claims.map((claim) => claim.text).join("\n"), blueprint.scenes.map((scene) => `${scene.purpose} ${scene.visualBeat}`).join("\n")] : [])];
  const allowedClaimIds = new Set((factPack?.claims ?? []).map((claim) => claim.id));
  const expectedDurationMs = manifest.words.at(-1)?.endMs ?? 0;

  // Tier B is one consolidated, separately routed review. Starting it before
  // the deterministic Tier A checks lets its network round-trip overlap them
  // instead of adding its full latency after they finish.
  const reviewBranch: Promise<QaTierResult> = (async () => {
    if (!run || !factPack || !blueprint) return { tier: "B", issues: [], checks: ["consolidated-review"] };
    const reviewStartedAt = Date.now();
    const reviewContext = {
      objective: blueprint.objective,
      scenes: blueprint.scenes,
      narration: script.narration,
      claims: factPack.claims,
      diagramLabels,
      captions: manifest.captions,
      preview: { durationMs: previewProbe.durationMs, width: previewProbe.width, height: previewProbe.height, fps: previewProbe.fps, hasAudio: previewProbe.hasAudio },
    };
    const qaRoute = resolveModelRoute("qa-review");
    const reviewRun = await withFallback(qaRoute, (attemptRoute) => reviewWithRoute(attemptRoute, `Independently review this lesson end to end against its verified claims and stated objective. Return schemaVersion "consolidated-review/v1" and issues [{domain,severity,evidence,remediation}], where domain is factual, pedagogy, visual, or audio. Use severity "critical" only for a genuine defect that blocks release. Do not rewrite the script, invent facts, or add labels.\n${JSON.stringify(reviewContext)}`), async (failedRoute, error) => {
      await recordUsage(runId, "qa", failedRoute.provider, failedRoute.model, reviewStartedAt, { model: failedRoute.model }, "consolidated-review/v1", { projection: "consolidated-review-context/v1" }, "failed", error.code);
    });
    await recordUsage(runId, "qa", reviewRun.route.provider, reviewRun.route.model, reviewStartedAt, reviewRun.value.usage, "consolidated-review/v1", contextManifest("consolidated-review-context/v1", [{ role: "fact-pack-script-preview", hash: sha(reviewContext), chars: JSON.stringify(reviewContext).length, itemCount: script.narration.length + factPack.claims.length + manifest.captions.length }]));
    return consolidatedReviewQa(ConsolidatedReviewSchema.parse(reviewRun.value.value));
  })();

  // Tier A: deterministic, zero-token gates. Nothing here can be satisfied by a
  // model's own claim that its output is valid.
  const tierA = deterministicQa(
    structuralQa({
      captions, previewPresent: Boolean(previewArtifact), missingArtifacts,
      sceneCount: manifest.scenes.length, scriptSceneCount,
      assetIds: assets.map((asset) => asset.id),
      sceneAssetIds: manifest.scenes.map((scene) => scene.layers.find((layer) => layer.assetId)?.assetId),
      ...(run && factPack && blueprint ? { domainPolicy: { domain: run.domain, script, factPack, blueprint, diagramLabels, assets: assets.map((asset) => ({ role: asset.role, provenance: asset.provenance })) } } : {}),
    }),
    visualQa({ canvas, safeArea: manifest.safeArea, captions: manifest.captions, words: manifest.words, lockedTexts, allowedClaimIds, diagramModels, palette, area }),
    audioRenderQa({ words: manifest.words, narrationDurationMs, loudness: narrationLoudness, pronunciation: { narrationText: canonicalNarrationText(script), curatedTerms }, preview: previewProbe, expected: { durationMs: expectedDurationMs, width: canvas.width, height: canvas.height, fps: manifest.fps, frames: Math.ceil((expectedDurationMs / 1000) * manifest.fps), codec: "h264" } }),
    spatialQa({ canvas, safeArea: manifest.safeArea, layouts }),
  );
  const tierB = await reviewBranch;

  // Both tiers must report before approval may be scheduled, and any critical
  // finding fails the run through the existing visible-failure path.
  const convergence = convergeQaTiers([tierA, tierB]);
  if (!convergence.complete) throw new Error("Release QA tiers did not converge: " + convergence.missing.join(", "));
  if (convergence.issues.length) {
    await getDb().insert(qaFindings).values(convergence.issues.map((issue) => ({ runId, rule: issue.rule, severity: "critical" as const, evidence: issue.evidence, remediation: issue.remediation })));
    throw new Error("Release QA failed: " + convergence.issues.map((issue) => issue.rule).join(", "));
  }
  return saveArtifact({
    runId, stage: "qa", role: "qa-report", schemaVersion: "qa-report/v1", inputHash: sha([manifest, captions]),
    content: { passed: true, tiers: [tierA, tierB].map((tier) => ({ tier: tier.tier, checks: tier.checks, findings: tier.issues.length })), checks: convergence.checks },
  });
};