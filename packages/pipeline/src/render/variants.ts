import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, renderOutputs } from "@upcraft/db";
import { getPrivateReadUrl, putPrivateObject } from "@upcraft/providers";
import { probeMedia, renderLesson } from "@upcraft/compositor";
import type { ProjectManifest } from "@upcraft/contracts";
import { validateRenderIntegrity } from "../media-qa.ts";
import { failWithFindings } from "../usage.ts";

/**
 * Export profiles for the final master. `video-generation-process.md` §13 allows
 * multiple render resolutions/formats to run in parallel after the approved
 * master composition locks.
 */
export const FINAL_EXPORT_PROFILES = [{ kind: "final-720p", scale: 2 / 3 }] as const;

export type RenderedVariant = { kind: string; scale: number; width: number; height: number; durationMs: number; sha256: string; objectKey: string; exportProfile: string };

/**
 * Renders the resolution variants in parallel from the same locked composition
 * and records each one with its export-profile provenance. Any variant that
 * fails render integrity blocks the run.
 */
export const renderResolutionVariants = async (params: {
  runId: string;
  runTitle: string;
  manifest: ProjectManifest;
  audioObjectKey: string;
  renderDir: string;
  expectedDurationMs: number;
  expectedFrames: number;
}): Promise<RenderedVariant[]> => {
  const { runId, runTitle, manifest, audioObjectKey, renderDir, expectedDurationMs, expectedFrames } = params;
  const variants: RenderedVariant[] = [];
  await Promise.all(FINAL_EXPORT_PROFILES.map(async (profile) => {
    const variantPath = join(renderDir, `${profile.kind}.mp4`);
    await renderLesson({ title: runTitle, manifest, audioUrl: await getPrivateReadUrl(audioObjectKey, 3_600), outputPath: variantPath, scale: profile.scale });
    const variantProbe = await probeMedia(variantPath);
    const variantWidth = Math.round(manifest.canvas.width * profile.scale);
    const variantHeight = Math.round(manifest.canvas.height * profile.scale);
    const variantIssues = validateRenderIntegrity({ probe: variantProbe, expectedDurationMs, expectedWidth: variantWidth, expectedHeight: variantHeight, expectedFps: manifest.fps, expectedFrames, requiredVideoCodec: "h264" });
    if (variantIssues.length) await failWithFindings(runId, `Variant render ${profile.kind}`, variantIssues);
    const variantObject = await putPrivateObject({ key: `runs/${runId}/renders/${profile.kind}.mp4`, body: await readFile(variantPath), contentType: "video/mp4" });
    await getDb().insert(renderOutputs).values({ runId, kind: profile.kind, objectKey: variantObject.key, sha256: variantObject.sha256, durationMs: variantProbe.durationMs, width: variantProbe.width, height: variantProbe.height }).onConflictDoUpdate({ target: [renderOutputs.runId, renderOutputs.kind], set: { objectKey: variantObject.key, sha256: variantObject.sha256, durationMs: variantProbe.durationMs } });
    variants.push({ kind: profile.kind, scale: profile.scale, width: variantProbe.width, height: variantProbe.height, durationMs: variantProbe.durationMs, sha256: variantObject.sha256, objectKey: variantObject.key, exportProfile: `h264/aac/jpeg@${variantProbe.width}x${variantProbe.height}` });
  }));
  return variants;
};