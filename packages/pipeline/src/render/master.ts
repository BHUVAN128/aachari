import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { ProjectManifestSchema } from "@upcraft/contracts";
import { getDb, mediaAssets, renderOutputs, videoRuns } from "@upcraft/db";
import { getPrivateReadUrl, putPrivateObject } from "@upcraft/providers";
import { deriveFrameCount, probeMedia, rendererVersion, renderLesson } from "@upcraft/compositor";
import { saveArtifact, requireContent } from "../artifacts/store.ts";
import { sha } from "../artifacts/hashing.ts";
import { failWithFindings } from "../usage.ts";
import { getRun } from "../runs.ts";
import { validateRenderIntegrity } from "../media-qa.ts";
import { buildSrt } from "../render-exports.ts";
import { renderResolutionVariants, type RenderedVariant } from "./variants.ts";
import type { StageContext } from "../pipeline/context.ts";

/**
 * §10/§12 M9 render master. Serves both the preview render (§10) and the final
 * render (§12): it consumes verified manifest references, probes the produced
 * bytes, and — for the final master — derives the SRT transcript and the
 * resolution variants in parallel from the same locked composition. No
 * placeholder is ever rendered for a missing selected asset.
 */
export const renderMaster = async (ctx: StageContext, kind: "preview" | "final"): Promise<unknown> => {
  const { runId } = ctx;
  const [run, manifestArtifact, voiceoverArtifact, assets] = await Promise.all([getRun(runId), ctx.getArtifact(runId, "project-manifest"), ctx.getArtifact(runId, "voiceover"), getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true)))]);
  if (!run) throw new Error("Run not found");
  const storedManifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const assetUrls = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await getPrivateReadUrl(asset.objectKey, 3_600)] as const)));
  const missingAssets = storedManifest.scenes.flatMap((scene) => scene.layers).filter((layer) => layer.assetId && !assetUrls.has(layer.assetId));
  if (missingAssets.length) await failWithFindings(runId, "Pre-render asset availability", missingAssets.map((layer) => ({ rule: "render-asset-unavailable", evidence: { layerId: layer.id, assetId: layer.assetId }, remediation: "Restore the missing selected asset before rendering; never render a placeholder in its place." })));
  const manifest = ProjectManifestSchema.parse({ ...storedManifest, scenes: storedManifest.scenes.map((scene) => ({ ...scene, layers: scene.layers.map((layer) => ({ ...layer, ...(layer.assetId && assetUrls.get(layer.assetId) ? { assetUrl: assetUrls.get(layer.assetId) } : {}) })) })) });
  const voiceover = requireContent<{ objectKey: string }>(voiceoverArtifact, "voiceover");
  const outputPath = join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId, `${kind}.mp4`);
  await mkdir(join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId), { recursive: true });
  await renderLesson({ title: run.title, manifest, audioUrl: await getPrivateReadUrl(voiceover.objectKey, 3_600), outputPath });
  const probe = await probeMedia(outputPath);
  const expectedDurationMs = manifest.words.at(-1)?.endMs ?? 0;
  const expectedFrames = Math.ceil((expectedDurationMs / 1000) * manifest.fps);
  const renderIssues = validateRenderIntegrity({ probe, expectedDurationMs, expectedWidth: manifest.canvas.width, expectedHeight: manifest.canvas.height, expectedFps: manifest.fps, expectedFrames, requiredVideoCodec: "h264" });
  if (renderIssues.length) await failWithFindings(runId, "Render integrity QA", renderIssues);
  const renderer = rendererVersion();
  await getDb().update(videoRuns).set({ rendererVersion: renderer }).where(eq(videoRuns.id, runId));
  const bytes = await readFile(outputPath);
  const object = await putPrivateObject({ key: `runs/${runId}/renders/${kind}.mp4`, body: bytes, contentType: "video/mp4" });
  await getDb().insert(renderOutputs).values({ runId, kind, objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs, width: probe.width, height: probe.height }).onConflictDoUpdate({ target: [renderOutputs.runId, renderOutputs.kind], set: { objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs } });

  // After the approved master is verified, derive the SRT/transcript and render
  // the resolution variants in parallel from the same locked composition. The
  // export-profile provenance is recorded on the final-render artifact.
  let transcript: { objectKey: string; sha256: string; format: "srt"; byteSize: number } | undefined;
  let variants: RenderedVariant[] = [];
  if (kind === "final") {
    const renderDir = join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId);
    const srt = buildSrt(manifest.captions);
    const srtObject = await putPrivateObject({ key: `runs/${runId}/renders/transcript.srt`, body: srt, contentType: "application/x-subrip" });
    await getDb().insert(renderOutputs).values({ runId, kind: "transcript-srt", objectKey: srtObject.key, sha256: srtObject.sha256, durationMs: probe.durationMs, width: probe.width, height: probe.height }).onConflictDoUpdate({ target: [renderOutputs.runId, renderOutputs.kind], set: { objectKey: srtObject.key, sha256: srtObject.sha256, durationMs: probe.durationMs } });
    transcript = { objectKey: srtObject.key, sha256: srtObject.sha256, format: "srt", byteSize: Buffer.byteLength(srt, "utf8") };
    variants = await renderResolutionVariants({ runId, runTitle: run.title, manifest, audioObjectKey: voiceover.objectKey, renderDir, expectedDurationMs, expectedFrames });
  }

  const provenance = { objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs, frameCount: deriveFrameCount(probe), width: probe.width, height: probe.height, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, rendererVersion: renderer, composition: "Lesson", exportProfile: "h264/aac/jpeg", ...(transcript ? { transcript } : {}), ...(variants.length ? { variants } : {}) };
  return saveArtifact({ runId, stage: kind === "preview" ? "preview-render" : "final-render", role: `${kind}-render`, schemaVersion: "render-output/v1", inputHash: sha(manifest), content: provenance });
};