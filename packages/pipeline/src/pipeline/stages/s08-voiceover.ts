import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { ApprovedScriptSchema, VerifiedFactPackSchema } from "@upcraft/contracts";
import { getDb, mediaAssets } from "@upcraft/db";
import { ProviderError, putPrivateObject, synthesizeNarration } from "@upcraft/providers";
import { probeAudioDurationMs, probeLoudness } from "@upcraft/compositor";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { recordUsage, failWithFindings } from "../../usage.ts";
import {
  buildCuratedTerms,
  runBoundedAlignmentSynthesis,
  validateLoudness,
  validateMeasuredBreaks,
  validatePacedAudio,
  validatePronunciation,
  validateVoiceAlignment,
  voiceoverInputHash,
} from "../../media-qa.ts";
import { canonicalNarrationText, contextManifest } from "../../context.ts";
import type { StageContext } from "../context.ts";

/**
 * §9 M8 Voiceover — one approved narration, measured from the produced bytes.
 *
 * Consumes only the *verified* fact pack (the only pack that advances to
 * planning), derives curated terms with the same function s13 uses, and gates
 * per-word alignment integrity and measured pauses *before* persisting. A defect
 * retries synthesis in a bounded loop; timestamps are never healed.
 */
export const runVoiceover = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [scriptArtifact, factArtifact] = await Promise.all([ctx.getArtifact(runId, "approved-script"), ctx.getArtifact(runId, "verified-fact-pack")]);
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const factPack = VerifiedFactPackSchema.parse(requireContent(factArtifact, "verified-fact-pack"));
  const voiceRoute = ctx.route("voiceover")!;
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? null;
  const narrationText = canonicalNarrationText(script);
  const curatedTerms = buildCuratedTerms({ narrationText, verifiedClaimTexts: factPack.claims.map((claim) => claim.text) });
  const inputHash = voiceoverInputHash({ script, verifiedFactPack: factPack, voice: { provider: voiceRoute.provider, model: voiceRoute.model, voiceId } });
  const existing = await ctx.getArtifact(runId, "voiceover");
  if (existing?.inputHash === inputHash) return existing;
  const projectManifest = () => contextManifest("canonical-narration/v1", [{ role: "approved-script", hash: sha(script), chars: narrationText.length, itemCount: script.narration.length }]);

  const synthesis = await runBoundedAlignmentSynthesis({
    synthesize: async (attempt) => {
      const attemptStartedAt = Date.now();
      try {
        const result = await synthesizeNarration(voiceRoute, narrationText);
        await recordUsage(runId, "voiceover", voiceRoute.provider, voiceRoute.model, attemptStartedAt, result.usage, "voiceover/v2", projectManifest(), "completed");
        return { words: result.value.words, value: result.value };
      } catch (error) {
        await recordUsage(runId, "voiceover", voiceRoute.provider, voiceRoute.model, attemptStartedAt, { model: voiceRoute.model }, "voiceover/v2", projectManifest(), "failed", error instanceof ProviderError ? error.code : "VOICEOVER_SYNTHESIS");
        throw error;
      }
    },
    gate: (words) => validateMeasuredBreaks({ lines: script.narration, words }),
    onAttempt: (attempt) => {
      if (attempt.outcome === "alignment-defect") void recordUsage(runId, "voiceover", voiceRoute.provider, voiceRoute.model, Date.now(), { model: voiceRoute.model }, "voiceover/v2", projectManifest(), "failed", "ALIGNMENT_DEFECT");
    },
  });
  const narration = synthesis.value;

  const probeDir = await mkdtemp(join(tmpdir(), "upcraft-voice-"));
  let measuredDurationMs: number;
  let loudness: Awaited<ReturnType<typeof probeLoudness>>;
  try {
    const audioPath = join(probeDir, "narration.mp3");
    await writeFile(audioPath, narration.bytes);
    measuredDurationMs = await probeAudioDurationMs(audioPath);
    loudness = await probeLoudness(audioPath);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
  const voiceIssues = [
    ...validateVoiceAlignment({ words: narration.words, measuredDurationMs }),
    ...validateLoudness({ probe: loudness }),
    ...validatePronunciation({ narrationText, words: narration.words, curatedTerms }),
    ...validatePacedAudio({ script, measuredDurationMs }),
  ];
  if (voiceIssues.length) await failWithFindings(runId, "Voiceover QA", voiceIssues);
  const object = await putPrivateObject({ key: `runs/${runId}/audio/narration.mp3`, body: narration.bytes, contentType: "audio/mpeg" });
  const [asset] = await getDb().insert(mediaAssets).values({ runId, role: "narration", objectKey: object.key, sha256: object.sha256, mimeType: "audio/mpeg", byteSize: object.byteSize, selected: true, provenance: { voiceId, model: voiceRoute.model, loudness, curatedTerms } }).onConflictDoNothing().returning();
  const stableAsset = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, "narration"), eq(mediaAssets.sha256, object.sha256))))[0];
  if (!stableAsset) throw new Error("Narration asset persistence failed");
  return saveArtifact({ runId, stage: "voiceover", role: "voiceover", schemaVersion: "voiceover/v1", inputHash, content: { assetId: stableAsset.id, objectKey: object.key, words: narration.words, loudness, curatedTerms } });
};
