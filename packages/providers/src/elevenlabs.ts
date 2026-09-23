import { asProviderError } from "./errors.ts";
import type { ModelRoute } from "@upcraft/contracts";
import type { WordTiming } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

const PAUSE_TAG_GLOBAL = /<break\s+time="[\d.]+s"\s*\/>/g;

/**
 * Removes reserved-pause break tags from the character alignment so the
 * deterministic `<break .../>` tags never become phantom words. The line
 * separators ("\n\n") remain, so words across a break stay distinct.
 */
const stripPauseTagsFromAlignment = (alignment: Alignment): Alignment => {
  const text = alignment.characters.join("");
  const keep = new Array<boolean>(alignment.characters.length).fill(true);
  let match: RegExpExecArray | null;
  PAUSE_TAG_GLOBAL.lastIndex = 0;
  while ((match = PAUSE_TAG_GLOBAL.exec(text)) !== null) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) keep[index] = false;
  }
  if (keep.every(Boolean)) return alignment;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < alignment.characters.length; index += 1) {
    if (!keep[index]) continue;
    characters.push(alignment.characters[index]!);
    starts.push(alignment.character_start_times_seconds[index]!);
    ends.push(alignment.character_end_times_seconds[index]!);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
};

const wordTimingsFromAlignment = (input: Alignment): WordTiming[] => {
  const alignment = stripPauseTagsFromAlignment(input);
  const words: WordTiming[] = [];
  let start = 0;
  for (let index = 0; index <= alignment.characters.length; index += 1) {
    const atEnd = index === alignment.characters.length;
    if (!atEnd && !/\s/.test(alignment.characters[index] ?? "")) continue;
    if (index > start) {
      const text = alignment.characters.slice(start, index).join("");
      const startSeconds = alignment.character_start_times_seconds[start];
      const endSeconds = alignment.character_end_times_seconds[index - 1];
      if (text && startSeconds !== undefined && endSeconds !== undefined) {
        words.push({ text, startMs: Math.floor(startSeconds * 1000), endMs: Math.ceil(endSeconds * 1000) });
      }
    }
    start = index + 1;
  }
  return words;
};

export const synthesizeNarration = async (route: ModelRoute, text: string): Promise<ProviderResult<{ bytes: Buffer; words: WordTiming[] }>> => {
  const voiceId = required("ELEVENLABS_VOICE_ID");
  const model = route.model;
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": required("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: model, output_format: "mp3_44100_128" }),
  });
  if (!response.ok) throw asProviderError("elevenlabs", response, await response.text());
  const payload = await response.json() as { audio_base64?: string; alignment?: Alignment };
  if (!payload.audio_base64 || !payload.alignment) throw new Error("ElevenLabs response did not include audio and alignment");
  const bytes = Buffer.from(payload.audio_base64, "base64");
  return { value: { bytes, words: wordTimingsFromAlignment(payload.alignment) }, usage: { model, inputCharacters: text.length, outputCharacters: bytes.length } };
};
