import { ApprovedScriptSchema } from "@upcraft/contracts";
import type { WordTiming } from "@upcraft/contracts";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { lineBoundaryIndexes, packCaptionCues } from "../../media-qa.ts";
import type { StageContext } from "../context.ts";

/**
 * §9 M8 Captions — derived deterministically from the locked word alignment with
 * the shared width/boundary/pause-aware packer, so a cue never straddles a script
 * line or a reserved inspection pause.
 */
export const runCaptions = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [voiceoverArtifact, scriptArtifact] = await Promise.all([ctx.getArtifact(runId, "voiceover"), ctx.getArtifact(runId, "approved-script")]);
  const voiceover = requireContent<{ words: WordTiming[] }>(voiceoverArtifact, "voiceover");
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const words = voiceover.words;
  if (!words.length || words.some((word, index) => word.endMs <= word.startMs || (index > 0 && word.startMs < (words[index - 1]?.endMs ?? 0)))) throw new Error("Word alignment is invalid");
  const cues = packCaptionCues({ words, lineBoundaries: lineBoundaryIndexes(script.narration) });
  return saveArtifact({ runId, stage: "captions", role: "caption-timings", schemaVersion: "caption-timings/v1", inputHash: sha([voiceover, scriptArtifact?.sha256 ?? null]), content: { words, cues } });
};
