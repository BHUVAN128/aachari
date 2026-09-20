import { and, eq } from "drizzle-orm";
import { ApprovedScriptSchema, ProjectManifestSchema, ResolvedLayoutSchema, type WordTiming } from "@upcraft/contracts";
import { getDb, mediaAssets } from "@upcraft/db";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { getRun } from "../../runs.ts";
import type { StageContext } from "../context.ts";

/** §10 M9 Composition — build a typed `video-manifest/v1` from locked artifacts. */
export const runManifest = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [run, voiceoverArtifact, captionsArtifact, layoutArtifact, scriptArtifact, blueprintArtifact, bibleArtifact, assets] = await Promise.all([
    getRun(runId), ctx.getArtifact(runId, "voiceover"), ctx.getArtifact(runId, "caption-timings"), ctx.getArtifact(runId, "resolved-layout"),
    ctx.getArtifact(runId, "approved-script"), ctx.getArtifact(runId, "lesson-blueprint"), ctx.getArtifact(runId, "visual-bible"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
  ]);
  if (!run || !voiceoverArtifact || !captionsArtifact || !layoutArtifact || !scriptArtifact || !blueprintArtifact || !bibleArtifact) throw new Error("Manifest prerequisites are incomplete");
  const voiceover = requireContent<{ assetId?: string }>(voiceoverArtifact, "voiceover");
  if (!voiceover.assetId) throw new Error("Voiceover has no persisted narration asset");
  const captions = requireContent<{ words: WordTiming[]; cues: Array<{ text: string; startMs: number; endMs: number; wordIndexes: number[] }> }>(captionsArtifact, "caption-timings");
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const blueprint = requireContent<{ scenes: Array<{ id: string; purpose: string; visualBeat: string }> }>(blueprintArtifact, "lesson-blueprint");
  const bible = requireContent<{ captionSafeArea: { top: number; right: number; bottom: number; left: number } }>(bibleArtifact, "visual-bible");
  const layoutBundle = requireContent<{ canvas: { width: number; height: number }; layouts: unknown[] }>(layoutArtifact, "resolved-layout");
  const layouts = layoutBundle.layouts.map((layout) => ResolvedLayoutSchema.parse(layout));
  const normalizeWord = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  let wordCursor = 0;
  const boundaries = new Map<string, { startMs: number; endMs: number; visualBeat: string }>();
  for (const line of script.narration) {
    const expected = line.text.trim().split(/\s+/).filter(Boolean);
    const actual = captions.words.slice(wordCursor, wordCursor + expected.length);
    if (actual.length !== expected.length || actual.some((word, index) => normalizeWord(word.text) !== normalizeWord(expected[index] ?? ""))) throw new Error("Voice alignment does not match approved script line " + line.id);
    const first = actual[0]; const last = actual.at(-1);
    if (!first || !last) throw new Error("Voice alignment is missing for script line " + line.id);
    const current = boundaries.get(line.sceneId);
    boundaries.set(line.sceneId, { startMs: current ? Math.min(current.startMs, first.startMs) : first.startMs, endMs: Math.max(current?.endMs ?? 0, last.endMs), visualBeat: line.visualAction });
    wordCursor += expected.length;
  }
  if (wordCursor !== captions.words.length) throw new Error("Voice alignment contains words outside the approved script");
  const safeArea = { top: Math.round(bible.captionSafeArea.top * layoutBundle.canvas.height), right: Math.round(bible.captionSafeArea.right * layoutBundle.canvas.width), bottom: Math.round(bible.captionSafeArea.bottom * layoutBundle.canvas.height), left: Math.round(bible.captionSafeArea.left * layoutBundle.canvas.width) };
  if ([bible.captionSafeArea.top, bible.captionSafeArea.right, bible.captionSafeArea.bottom, bible.captionSafeArea.left].some((value) => value > 1)) throw new Error("Visual bible safe-area values must be fractions");
  const scenes = [...boundaries.entries()].map(([sceneId, timing]) => {
    const layout = layouts.find((candidate) => candidate.sceneId === sceneId);
    const blueprintScene = blueprint.scenes.find((scene) => scene.id === sceneId);
    const asset = assets.find((candidate) => candidate.sceneId === sceneId && candidate.role === "diagram-" + sceneId);
    if (!layout || !blueprintScene || !asset) throw new Error("Manifest scene " + sceneId + " is missing layout, blueprint, or selected asset");
    const layers = layout.layers.map((layer) => ({
      id: layer.id,
      kind: layer.id.startsWith("illustration-") ? ("illustration" as const) : ("diagram" as const),
      assetId: layer.assetId ?? asset.id,
      zIndex: layer.zIndex,
      bounds: layer.bounds,
    }));
    return { sceneId, layoutArtifactId: layoutArtifact.id, startMs: timing.startMs, endMs: timing.endMs, title: blueprintScene.purpose, visualBeat: timing.visualBeat, layers };
  });
  const manifest = ProjectManifestSchema.parse({ schemaVersion: "video-manifest/v1", fps: 30, canvas: layoutBundle.canvas, safeArea, narrationAssetId: voiceover.assetId, words: captions.words, captions: captions.cues, scenes });
  return saveArtifact({ runId, stage: "manifest", role: "project-manifest", schemaVersion: manifest.schemaVersion, inputHash: sha([voiceoverArtifact?.sha256, captionsArtifact?.sha256, layoutArtifact?.sha256]), content: manifest });
};