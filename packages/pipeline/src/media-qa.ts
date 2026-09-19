import { contrastRatio, estimatedTextWidth, type MediaProbe } from "@upcraft/compositor";
import type { CaptionCue, WordTiming } from "@upcraft/contracts";

/**
 * Deterministic media checks recomputed from the locked manifest and the actual
 * rendered bytes. Follows the diagram-QA pattern: a validator inspects evidence
 * independently of the stage that produced it and returns findings instead of
 * silently trusting a requested output.
 */
export type MediaIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

/**
 * Caption geometry constants that mirror the composition exactly. If the
 * composition changes, these must change with it, otherwise the QA gate would
 * measure a layout that is not rendered.
 */
export const CAPTION_FONT_SIZE = 58;
export const CAPTION_LINE_HEIGHT = 1.12;
export const CAPTION_HORIZONTAL_PADDING = 34;
export const CAPTION_VERTICAL_PADDING = 20;
export const CAPTION_MAX_WIDTH = 1300;
export const CAPTION_MAX_WORDS = 8;
export const CAPTION_BACKGROUND = "#0f172a";
export const CAPTION_BACKGROUND_ALPHA = 0.84;
export const CAPTION_TEXT_COLOR = "#f8fafc";
export const MIN_CAPTION_CONTRAST = 4.5;

const hexToRgb = (hex: string) => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Caption color must be a six-digit hex value: ${hex}`);
  const int = Number.parseInt(match[1]!, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
};

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  "#" + [r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("");

/** Flattens a translucent caption panel over its worst-case backdrop. */
export const compositeCaptionFill = (backdrop: string) => {
  const front = hexToRgb(CAPTION_BACKGROUND);
  const back = hexToRgb(backdrop);
  return rgbToHex({
    r: front.r * CAPTION_BACKGROUND_ALPHA + back.r * (1 - CAPTION_BACKGROUND_ALPHA),
    g: front.g * CAPTION_BACKGROUND_ALPHA + back.g * (1 - CAPTION_BACKGROUND_ALPHA),
    b: front.b * CAPTION_BACKGROUND_ALPHA + back.b * (1 - CAPTION_BACKGROUND_ALPHA),
  });
};

export const captionLines = (text: string, contentWidth: number) =>
  Math.max(1, Math.ceil(estimatedTextWidth(text, CAPTION_FONT_SIZE) / Math.max(1, contentWidth)));

/**
 * Caption checks: exact wording reconstructed from the locked word alignment,
 * word/line limits, safe-area containment, and text/panel contrast over the
 * lightest and darkest plausible backdrops.
 */
export const validateCaptionLayout = (params: {
  canvas: { width: number; height: number };
  safeArea: { top: number; right: number; bottom: number; left: number };
  captions: CaptionCue[];
  words: WordTiming[];
}): MediaIssue[] => {
  const { canvas, safeArea, captions, words } = params;
  const issues: MediaIssue[] = [];
  const contentWidth = Math.min(CAPTION_MAX_WIDTH, canvas.width - safeArea.left - safeArea.right) - CAPTION_HORIZONTAL_PADDING * 2;
  const maxBlockHeight = canvas.height - safeArea.top - safeArea.bottom;

  for (const cue of captions) {
    const cueWords = cue.wordIndexes.map((index) => words[index]).filter((word): word is WordTiming => Boolean(word));
    if (cueWords.length !== cue.wordIndexes.length) {
      issues.push({ rule: "caption-index-integrity", evidence: { cue: cue.text }, remediation: "Rebuild captions with indexes into the locked word alignment." });
      continue;
    }
    const reconstructed = cueWords.map((word) => word.text).join(" ");
    if (reconstructed !== cue.text) {
      issues.push({ rule: "caption-wording-drift", evidence: { cue: cue.text, reconstructed }, remediation: "Derive captions from the rendered narration, never from a paraphrased script." });
    }
    if (cueWords.length > CAPTION_MAX_WORDS) {
      issues.push({ rule: "caption-too-many-words", evidence: { cue: cue.text, words: cueWords.length, maximum: CAPTION_MAX_WORDS }, remediation: "Split the caption into shorter phrase cues." });
    }
    const first = cueWords[0];
    const last = cueWords.at(-1);
    if (first && last && (first.startMs !== cue.startMs || last.endMs !== cue.endMs)) {
      issues.push({ rule: "caption-word-timing-mismatch", evidence: { cue: cue.text, cueStartMs: cue.startMs, cueEndMs: cue.endMs, wordStartMs: first.startMs, wordEndMs: last.endMs }, remediation: "Recompute cue bounds directly from the aligned word timings." });
    }
    const lines = captionLines(cue.text, contentWidth);
    const blockHeight = lines * CAPTION_FONT_SIZE * CAPTION_LINE_HEIGHT + CAPTION_VERTICAL_PADDING * 2;
    if (blockHeight > maxBlockHeight) {
      issues.push({ rule: "caption-safe-area-overflow", evidence: { cue: cue.text, lines, blockHeight, maxBlockHeight }, remediation: "Shorten the caption cue or widen the safe area so the caption cannot exceed the canvas." });
    }
  }

  const worstLight = compositeCaptionFill("#ffffff");
  const worstDark = compositeCaptionFill("#000000");
  const contrast = Math.min(contrastRatio(CAPTION_TEXT_COLOR, worstLight), contrastRatio(CAPTION_TEXT_COLOR, worstDark));
  if (contrast < MIN_CAPTION_CONTRAST) {
    issues.push({ rule: "caption-contrast", evidence: { contrast, minimum: MIN_CAPTION_CONTRAST }, remediation: "Increase the caption panel opacity or lighten the caption text to meet the 4.5:1 gate." });
  }

  return issues;
};

/** Measured audio duration must agree with the transcribed word alignment. */
export const validateVoiceAlignment = (params: { words: WordTiming[]; measuredDurationMs: number; toleranceMs?: number }): MediaIssue[] => {
  const { words, measuredDurationMs } = params;
  const issues: MediaIssue[] = [];
  if (!words.length) return [{ rule: "voice-alignment-missing", evidence: {}, remediation: "Regenerate the voiceover with word alignment." }];
  if (!(measuredDurationMs > 0)) return [{ rule: "voice-duration-unmeasured", evidence: { measuredDurationMs }, remediation: "Probe the rendered audio track before accepting the voiceover." }];
  const lastEndMs = words.at(-1)!.endMs;
  const trailing = measuredDurationMs - lastEndMs;
  const tolerance = params.toleranceMs ?? Math.max(400, Math.round(measuredDurationMs * 0.05));
  if (trailing < -tolerance) {
    issues.push({ rule: "voice-alignment-exceeds-audio", evidence: { measuredDurationMs, lastEndMs, trailing, tolerance }, remediation: "Regenerate the voiceover; alignment cannot extend past the audio." });
  } else if (trailing > tolerance) {
    issues.push({ rule: "voice-audio-trailing-gap", evidence: { measuredDurationMs, lastEndMs, trailing, tolerance }, remediation: "Regenerate the voiceover or verify the alignment covers the whole narration." });
  }
  return issues;
};

/** Render integrity measured from the produced file, never from the request. */
export const validateRenderIntegrity = (params: {
  probe: MediaProbe;
  expectedDurationMs: number;
  expectedWidth: number;
  expectedHeight: number;
  expectedFps: number;
  expectedFrames: number;
  durationToleranceMs?: number;
  frameTolerance?: number;
  requiredVideoCodec?: string;
}): MediaIssue[] => {
  const { probe } = params;
  const issues: MediaIssue[] = [];
  if (probe.width !== params.expectedWidth || probe.height !== params.expectedHeight) {
    issues.push({ rule: "render-dimensions", evidence: { measured: { width: probe.width, height: probe.height }, expected: { width: params.expectedWidth, height: params.expectedHeight } }, remediation: "Re-render with the export profile locked in the manifest." });
  }
  const durationTolerance = params.durationToleranceMs ?? Math.max(250, params.expectedDurationMs * 0.02);
  if (Math.abs(probe.durationMs - params.expectedDurationMs) > durationTolerance) {
    issues.push({ rule: "render-duration", evidence: { measuredMs: probe.durationMs, expectedMs: params.expectedDurationMs, tolerance: durationTolerance }, remediation: "Re-render; measured duration must match the locked manifest timing." });
  }
  if (Math.abs(probe.fps - params.expectedFps) > 0.5) {
    issues.push({ rule: "render-fps", evidence: { measured: probe.fps, expected: params.expectedFps }, remediation: "Re-render with the manifest frame rate." });
  }
  const measuredFrames = Math.round((probe.durationMs / 1000) * probe.fps);
  const frameTolerance = params.frameTolerance ?? 2;
  if (params.expectedFrames > 0 && Math.abs(measuredFrames - params.expectedFrames) > frameTolerance) {
    issues.push({ rule: "render-frame-count", evidence: { measured: measuredFrames, expected: params.expectedFrames, tolerance: frameTolerance }, remediation: "Re-render; dropped or extra frames fail the render-integrity gate." });
  }
  if (!probe.hasAudio) {
    issues.push({ rule: "render-audio-missing", evidence: { audioCodec: probe.audioCodec }, remediation: "Re-render with the locked narration track attached." });
  }
  if (params.requiredVideoCodec && probe.videoCodec !== params.requiredVideoCodec) {
    issues.push({ rule: "render-export-profile", evidence: { measuredCodec: probe.videoCodec, requiredCodec: params.requiredVideoCodec }, remediation: "Re-render with the required export profile codec." });
  }
  return issues;
};
