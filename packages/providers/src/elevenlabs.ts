import { asProviderError } from "./errors.ts";
import type { WordTiming } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

const wordTimingsFromAlignment = (alignment: Alignment): WordTiming[] => {
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

export const synthesizeNarration = async (text: string): Promise<ProviderResult<{ bytes: Buffer; words: WordTiming[] }>> => {
  const voiceId = required("ELEVENLABS_VOICE_ID");
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": required("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2", output_format: "mp3_44100_128" }),
  });
  if (!response.ok) throw asProviderError("elevenlabs", response, await response.text());
  const payload = await response.json() as { audio_base64?: string; alignment?: Alignment };
  if (!payload.audio_base64 || !payload.alignment) throw new Error("ElevenLabs response did not include audio and alignment");
  const bytes = Buffer.from(payload.audio_base64, "base64");
  return { value: { bytes, words: wordTimingsFromAlignment(payload.alignment) }, usage: { model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2", inputCharacters: text.length, outputCharacters: bytes.length } };
};
