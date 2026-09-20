import type { CaptionCue } from "@upcraft/contracts";

/**
 * Deterministic transcript/SRT derivation from the locked caption cues. The doc
 * requires the release stage to produce "MP4 and optional SRT/transcript" from
 * the approved manifest, so captions are exported from the same canonical cues
 * the renderer burns in — never re-paraphrased from the script.
 */
const pad = (value: number, length: number) => String(value).padStart(length, "0");

export const srtTimestamp = (milliseconds: number): string => {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
};

export const buildSrt = (captions: Array<Pick<CaptionCue, "text" | "startMs" | "endMs">>): string => {
  if (!captions.length) return "";
  return captions
    .map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text.trim()}\n`)
    .join("\n");
};
