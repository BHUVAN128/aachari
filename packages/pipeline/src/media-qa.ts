import { contrastRatio, estimatedTextWidth, type LoudnessProbe, type MediaProbe } from "@upcraft/compositor";
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

/**
 * EBU R128 loudness gate. Online narration targets -16 LUFS with a bounded
 * tolerance, and the true peak must stay clear of 0 dBFS so the mix cannot clip
 * on any playback system. Measured with the renderer's ffmpeg, never assumed.
 */
export const TARGET_INTEGRATED_LUFS = -16;
export const LOUDNESS_TOLERANCE_LUFS = 4;
export const MAX_TRUE_PEAK_DB = -1;

export const validateLoudness = (params: {
  probe?: LoudnessProbe;
  targetLufs?: number;
  toleranceLufs?: number;
  maxTruePeakDb?: number;
}): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  const { probe } = params;
  if (!probe || !Number.isFinite(probe.integratedLufs) || !Number.isFinite(probe.truePeakDb)) {
    return [{ rule: "voice-loudness-unmeasured", evidence: { probe: probe ?? null }, remediation: "Measure the narration's integrated loudness and true peak from the produced audio bytes." }];
  }
  const target = params.targetLufs ?? TARGET_INTEGRATED_LUFS;
  const tolerance = params.toleranceLufs ?? LOUDNESS_TOLERANCE_LUFS;
  if (Math.abs(probe.integratedLufs - target) > tolerance) {
    issues.push({ rule: "voice-loudness-out-of-range", evidence: { integratedLufs: probe.integratedLufs, target, tolerance }, remediation: "Normalize the narration to the target integrated loudness before release." });
  }
  const maxPeak = params.maxTruePeakDb ?? MAX_TRUE_PEAK_DB;
  if (probe.truePeakDb > maxPeak) {
    issues.push({ rule: "voice-true-peak-clipping", evidence: { truePeakDb: probe.truePeakDb, maxTruePeakDb: maxPeak }, remediation: "Lower the narration gain so the true peak stays below the clipping ceiling." });
  }
  return issues;
};

const normalizeTerm = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const normalizePhrase = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;

/**
 * Derives the curated domain-term list only from locked claim and narration
 * text. Long technical tokens and all-caps acronyms are the terms whose
 * pronunciation a TTS voice most often mangles, so they must be accepted by the
 * alignment before the voiceover can advance.
 */
export const curatedDomainTerms = (texts: string[], options: { minLength?: number; limit?: number } = {}): string[] => {
  const minLength = options.minLength ?? 8;
  const limit = options.limit ?? 40;
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of text.split(/\s+/)) {
      const cleaned = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const normalized = normalizeTerm(cleaned);
      if (normalized.length >= minLength && /[\p{L}]/u.test(normalized)) terms.add(normalized);
    }
    for (const acronym of text.match(ACRONYM_PATTERN) ?? []) terms.add(normalizeTerm(acronym));
  }
  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, limit);
};

/**
 * Deterministic pronunciation gate: any curated domain term that appears in the
 * locked narration text must appear in the word alignment returned by TTS. A
 * term that the narration contains but the alignment does not means the voice
 * dropped, merged, or mis-rendered it, so the voiceover must be regenerated.
 */
export const validatePronunciation = (params: {
  narrationText: string;
  words: WordTiming[];
  curatedTerms: string[];
}): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  const narration = normalizePhrase(params.narrationText).replace(/ /g, "");
  const spoken = normalizePhrase(params.words.map((word) => word.text).join(" ")).replace(/ /g, "");
  for (const term of params.curatedTerms) {
    if (!term || !narration.includes(term)) continue;
    if (!spoken.includes(term)) {
      issues.push({ rule: "voice-pronunciation-term-missing", evidence: { term }, remediation: "Add a pronunciation note for the domain term or regenerate the voiceover so the alignment accepts it." });
    }
  }
  return issues;
};

/**
 * Reads intrinsic pixel dimensions directly from the returned bytes without
 * trusting provider metadata, so a mislabeled or truncated image is visible.
 */
export const imageDimensions = (bytes: Buffer, mimeType: string): { width: number; height: number } | undefined => {
  if (mimeType.includes("png")) {
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
    return undefined;
  }
  return undefined;
};

/**
 * Deterministic half of the image-asset gate; style/review remains a human gate.
 * Generated raster illustrations are PNG-only: factual labels, arrows, diagrams,
 * equations, and captions are deterministic SVG/Remotion instead.
 */
export const validateIllustrationCandidate = (params: {
  bytes: Buffer;
  mimeType: string;
  allowedMimeTypes?: string[];
  maxBytes?: number;
  minWidth?: number;
  minHeight?: number;
}): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  const allowed = params.allowedMimeTypes ?? ["image/png"];
  if (!allowed.includes(params.mimeType)) {
    issues.push({ rule: "illustration-mime-type", evidence: { mimeType: params.mimeType, allowed }, remediation: "Reject the candidate; only verified image MIME types may attach to a run." });
  }
  const maxBytes = params.maxBytes ?? 8_000_000;
  if (params.bytes.byteLength === 0 || params.bytes.byteLength > maxBytes) {
    issues.push({ rule: "illustration-bytes", evidence: { byteSize: params.bytes.byteLength, maxBytes }, remediation: "Reject the candidate and regenerate within the byte budget." });
  }
  const dimensions = imageDimensions(params.bytes, params.mimeType);
  if (!dimensions) {
    issues.push({ rule: "illustration-dimensions-unreadable", evidence: { mimeType: params.mimeType }, remediation: "Reject the candidate; dimensions must be recoverable from the bytes." });
  } else {
    if (dimensions.width < (params.minWidth ?? 512) || dimensions.height < (params.minHeight ?? 512)) {
      issues.push({ rule: "illustration-dimensions", evidence: { ...dimensions, minWidth: params.minWidth ?? 512, minHeight: params.minHeight ?? 512 }, remediation: "Reject the candidate and regenerate at an adequate resolution." });
    }
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
