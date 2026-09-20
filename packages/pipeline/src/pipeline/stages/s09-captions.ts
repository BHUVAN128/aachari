import type { WordTiming } from "@upcraft/contracts";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import type { StageContext } from "../context.ts";

/** §9 M8 Captions — derived deterministically from the locked word alignment. */
export const runCaptions = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const voiceover = requireContent<{ words: WordTiming[] }>(await ctx.getArtifact(runId, "voiceover"), "voiceover");
  const words = voiceover.words;
  if (!words.length || words.some((word, index) => word.endMs <= word.startMs || (index > 0 && word.startMs < (words[index - 1]?.endMs ?? 0)))) throw new Error("Word alignment is invalid");
  const cues = words.reduce<Array<{ text: string; startMs: number; endMs: number; wordIndexes: number[] }>>((result, word, index) => { const current = result.at(-1); if (!current || current.wordIndexes.length >= 8) result.push({ text: word.text, startMs: word.startMs, endMs: word.endMs, wordIndexes: [index] }); else { current.text += " " + word.text; current.endMs = word.endMs; current.wordIndexes.push(index); } return result; }, []);
  return saveArtifact({ runId, stage: "captions", role: "caption-timings", schemaVersion: "caption-timings/v1", inputHash: sha(voiceover), content: { words, cues } });
};