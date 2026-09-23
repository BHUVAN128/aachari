import { createHash } from "node:crypto";
import { contrastRatio, estimatedTextWidth, type LoudnessProbe, type MediaProbe } from "@upcraft/compositor";
import type { CaptionCue, CaptionSafeArea, WordTiming } from "@upcraft/contracts";

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
  // Per-word integrity. ElevenLabs floors starts and ceils ends, so a very short
  // word can become start === end and would otherwise only be caught by s09's
  // throw — after the artifact was already persisted and made idempotent.
  const malformed = words.filter((word) => !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= 0);
  if (malformed.length) {
    issues.push({ rule: "voice-alignment-word-malformed", evidence: { count: malformed.length, sample: malformed.slice(0, 3) }, remediation: "Regenerate the voiceover; every word needs finite non-negative bounds." });
  }
  const nonpositive = words.filter((word) => word.endMs <= word.startMs);
  if (nonpositive.length) {
    issues.push({ rule: "voice-alignment-word-nonpositive", evidence: { count: nonpositive.length, sample: nonpositive.slice(0, 3) }, remediation: "Re-synthesize the narration alignment; a zero-length word is a transport defect, never silently healed." });
  }
  const nonmonotonic = words.filter((word, index) => index > 0 && word.startMs < (words[index - 1]?.endMs ?? 0));
  if (nonmonotonic.length) {
    issues.push({ rule: "voice-alignment-non-monotonic", evidence: { count: nonmonotonic.length }, remediation: "Correct the break-offset mapping so timestamps never move backwards." });
  }
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

// ---------------------------------------------------------------------------
// Promoted hardening (Gap 2 + W1–W4): one source of truth for pacing, curated
// terms, alignment integrity, renderer language, and caption geometry.
// ---------------------------------------------------------------------------

/** Gap 2 pacing policy. Stricter than the contract cap so a pause never crowds speech. */
export const MAX_PAUSE_MS = 4_000;
export const MAX_TOTAL_PAUSE_RATIO = 0.35;
export const MIN_SPEECH_MS_PER_WORD = 180;

export type PacedNarration = { narration: Array<{ text: string; pauseMs?: number }> };

/** Deterministic dwell need per visual beat; never model-authored. */
export const pauseForVisualAction = (visualAction: string): number => {
  const normalized = visualAction.toLowerCase();
  if (/inspect|read the label|trace|compare|examine/.test(normalized)) return 2_000;
  if (/reveal|build|assemble|draw|map/.test(normalized)) return 1_000;
  return 0;
};

export const sumPauses = (script: PacedNarration): number => script.narration.reduce((sum, line) => sum + (line.pauseMs ?? 0), 0);
export const estimatedSpeechMs = (script: PacedNarration, msPerWord = MIN_SPEECH_MS_PER_WORD): number =>
  script.narration.reduce((sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length * msPerWord, 0);

export const validatePacing = (params: { script: PacedNarration; durationSeconds: number }): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  const durationMs = params.durationSeconds * 1_000;
  for (const [index, line] of params.script.narration.entries()) {
    const pauseMs = line.pauseMs ?? 0;
    if (pauseMs < 0 || pauseMs > MAX_PAUSE_MS) {
      issues.push({ rule: "script-pause-out-of-range", evidence: { lineIndex: index, pauseMs, max: MAX_PAUSE_MS }, remediation: "Clamp the pause to the allowed per-line budget." });
    }
  }
  const pauses = sumPauses(params.script);
  const speech = estimatedSpeechMs(params.script);
  if (pauses > durationMs * MAX_TOTAL_PAUSE_RATIO) {
    issues.push({ rule: "script-pause-budget", evidence: { pauses, durationMs, ratio: MAX_TOTAL_PAUSE_RATIO }, remediation: "Reduce pauses so speech still dominates the requested duration." });
  }
  if (speech + pauses > durationMs * 1.4) {
    issues.push({ rule: "script-duration-overrun", evidence: { speech, pauses, durationMs }, remediation: "Shorten narration or reduce pauses to fit the requested duration." });
  }
  return issues;
};

/** Measured audio must cover speech plus every reserved pause. */
export const validatePacedAudio = (params: { script: PacedNarration; measuredDurationMs: number; toleranceMs?: number }): MediaIssue[] => {
  const required = estimatedSpeechMs(params.script) + sumPauses(params.script);
  const tolerance = params.toleranceMs ?? Math.max(400, Math.round(required * 0.05));
  if (params.measuredDurationMs + tolerance < required) {
    return [{ rule: "voice-pacing-underflow", evidence: { measuredDurationMs: params.measuredDurationMs, requiredMs: required, tolerance }, remediation: "Re-synthesize with the line-structured narration so every reserved pause is rendered." }];
  }
  return [];
};

/**
 * W2 — per-word alignment integrity, computed before anything is persisted. This
 * is the same signal s09 throws on, surfaced at s08 so a retry re-synthesizes
 * instead of replaying a poisoned idempotent artifact.
 */
export const validateAlignmentIntegrity = (words: WordTiming[]): MediaIssue[] => {
  if (!words.length) return [{ rule: "alignment-empty", evidence: {}, remediation: "Re-synthesize the narration; the alignment returned no words." }];
  const issues: MediaIssue[] = [];
  const malformed = words.filter((word) => !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= 0);
  if (malformed.length) issues.push({ rule: "voice-alignment-word-malformed", evidence: { count: malformed.length, sample: malformed.slice(0, 3) }, remediation: "Re-map from the rendered narration; every word needs finite non-negative bounds." });
  const nonpositive = words.filter((word) => word.endMs <= word.startMs);
  if (nonpositive.length) issues.push({ rule: "voice-alignment-word-nonpositive", evidence: { count: nonpositive.length, sample: nonpositive.slice(0, 3) }, remediation: "Re-synthesize the narration alignment; timestamps are evidence and are never healed." });
  const nonmonotonic = words.filter((word, index) => index > 0 && word.startMs < (words[index - 1]?.endMs ?? 0));
  if (nonmonotonic.length) issues.push({ rule: "voice-alignment-non-monotonic", evidence: { count: nonmonotonic.length }, remediation: "Correct the break-offset mapping so timestamps never move backwards." });
  return issues;
};

/**
 * Measured-gap gate (Gap 2). Splits the spoken alignment at the known per-line
 * word counts and asserts the silence after a line is at least its reserved pause
 * (minus tolerance). A break the transport dropped is visible instead of silently
 * collapsing the visual dwell; the caller retries with a bounded loop.
 */
export const validateMeasuredBreaks = (params: { lines: Array<{ text: string; pauseMs?: number }>; words: WordTiming[]; toleranceMs?: number }): MediaIssue[] => {
  const tolerance = params.toleranceMs ?? 150;
  const issues: MediaIssue[] = [];
  let cursor = 0;
  for (let index = 0; index < params.lines.length; index += 1) {
    const line = params.lines[index]!;
    const count = line.text.trim().split(/\s+/).filter(Boolean).length;
    const last = params.words[cursor + count - 1];
    if (count > 0 && !last) {
      issues.push({ rule: "voice-alignment-line-missing", evidence: { lineIndex: index }, remediation: "Re-synthesize; every structured line must appear in the alignment." });
      return issues;
    }
    const pauseMs = line.pauseMs ?? 0;
    const nextFirst = params.words[cursor + count];
    if (pauseMs > 0 && params.lines[index + 1] && last) {
      const measured = nextFirst ? nextFirst.startMs - last.endMs : -Infinity;
      const required = pauseMs - tolerance;
      if (measured < required) {
        issues.push({ rule: "voice-pause-not-rendered", evidence: { lineIndex: index, pauseMs, measuredMs: Number.isFinite(measured) ? measured : null, requiredMs: required }, remediation: "Re-synthesize with the structured break; the reserved inspection pause was not rendered." });
      }
    }
    cursor += count;
  }
  return issues;
};

export const MAX_ALIGNMENT_ATTEMPTS = 3;
export const ALIGNMENT_DEFECT = "ALIGNMENT_DEFECT";

export type AlignmentAttemptOutcome = "completed" | "alignment-defect";
export type AlignmentAttempt = { attempt: number; outcome: AlignmentAttemptOutcome; issues: MediaIssue[] };

export class AlignmentDefectExhaustedError extends Error {
  public readonly code = ALIGNMENT_DEFECT;
  public readonly attempts: AlignmentAttempt[];
  public constructor(attempts: AlignmentAttempt[]) {
    super(`${ALIGNMENT_DEFECT}: alignment failed integrity after ${attempts.length} attempt(s)`);
    this.name = "AlignmentDefectExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Bounded synthesis loop. A defect is retried up to `maxAttempts`; exhaustion is a
 * visible terminal failure that persists nothing, so a later replay re-synthesizes.
 */
export const runBoundedAlignmentSynthesis = async <T>(params: {
  synthesize: (attempt: number) => Promise<{ words: WordTiming[]; value: T }>;
  gate?: (words: WordTiming[]) => MediaIssue[];
  maxAttempts?: number;
  onAttempt?: (attempt: AlignmentAttempt) => void;
}): Promise<{ value: T; words: WordTiming[]; attempts: AlignmentAttempt[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_ALIGNMENT_ATTEMPTS;
  const attempts: AlignmentAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { words, value } = await params.synthesize(attempt);
    const issues = [...validateAlignmentIntegrity(words), ...(params.gate?.(words) ?? [])];
    const outcome: AlignmentAttemptOutcome = issues.length ? "alignment-defect" : "completed";
    const record: AlignmentAttempt = { attempt, outcome, issues };
    attempts.push(record);
    params.onAttempt?.(record);
    if (outcome === "completed") return { value, words, attempts };
  }
  throw new AlignmentDefectExhaustedError(attempts);
};

// --- W1: one curated-term derivation + voice-aware replay identity ---
/** Token-level derivation shared by the curated-term builders. */
export const deriveDomainTerms = (texts: string[], minLength = 8): string[] => {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of text.split(/\s+/)) {
      const cleaned = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const normalized = normalizeTerm(cleaned);
      if (normalized.length >= minLength && /[\p{L}]/u.test(normalized)) terms.add(normalized);
    }
    for (const acronym of text.match(ACRONYM_PATTERN) ?? []) terms.add(normalizeTerm(acronym));
  }
  return [...terms];
};

const rankTerms = (terms: string[]) => [...new Set(terms)].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * The single curated-term derivation used by both s08 and s13. Narration-derived
 * terms are always included first (they are the only enforceable ones because the
 * pronunciation gate checks terms present in the narration); verified-claim-only
 * terms fill the remaining limit budget. No raw/unverified claim token can ever
 * displace a narration term.
 */
export const buildCuratedTerms = (params: {
  narrationText: string;
  verifiedClaimTexts: string[];
  minLength?: number;
  limit?: number;
}): string[] => {
  const limit = params.limit ?? 40;
  const narrationTerms = rankTerms(deriveDomainTerms([params.narrationText], params.minLength ?? 8));
  const narrationSet = new Set(narrationTerms);
  const claimTerms = rankTerms(deriveDomainTerms(params.verifiedClaimTexts, params.minLength ?? 8)).filter((term) => !narrationSet.has(term));
  return [...narrationTerms, ...claimTerms].slice(0, limit);
};

export type VoiceIdentity = { provider: string; model: string; voiceId?: string | null };

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Replay identity that binds the locked script, verified pack, and voice identity. */
export const voiceoverInputHash = (params: { script: unknown; verifiedFactPack: unknown; voice: VoiceIdentity }): string =>
  sha([params.script, params.verifiedFactPack, { provider: params.voice.provider, model: params.voice.model, voiceId: params.voice.voiceId ?? null }]);

// --- W3: renderer-language directive (visualAction + persistent entities) ---
export const MAX_LANGUAGE_DIRECTIVE_ATTEMPTS = 3;
export const SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED = "SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED";

export const VISUAL_ACTION_DIRECTION_KEYWORDS = [
  "reveal", "inspect", "read", "trace", "compare", "examine", "build", "assemble",
  "draw", "map", "animate", "zoom", "highlight", "pan", "label", "show", "display",
  "illustrate", "split", "explode", "rotate", "transition", "overlay", "underline",
  "circle", "arrow", "graph", "chart", "diagram", "morph", "fade", "focus", "frame",
  "sequence", "sketch", "outline", "magnify", "point", "connect", "stack", "layer",
  "timeline", "walk", "step", "spin", "tilt", "slide", "mark", "annotate", "model",
  "cut", "grow", "shrink", "pulse", "glide",
] as const;

const DIRECTION_PATTERN = new RegExp(`^(${VISUAL_ACTION_DIRECTION_KEYWORDS.join("|")})\\b`, "i");
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

export const isNonEnglishScript = (value: string): boolean => NON_LATIN_SCRIPT.test(value);
export const startsWithDirectionVerb = (value: string): boolean => DIRECTION_PATTERN.test(value.trim());

export const VISUAL_ACTION_PROMPT_RULES = [
  "Write every narration line in the learner's target language.",
  "Write every visualAction strictly in English, regardless of the target language; it is an internal renderer instruction, never learner-facing text.",
  "Start each visualAction with a visual-direction verb and name the canvas change (for example \"Reveal the leaf cross-section, then trace light energy into the chloroplast\").",
  "Write every persistent entity description in English for the same reason.",
].join(" ");

export const validateVisualActionLanguage = (visualAction: string): MediaIssue[] => {
  if (isNonEnglishScript(visualAction)) return [{ rule: "script-visual-action-localized", evidence: { visualAction, detectedScript: "non-latin" }, remediation: "Rewrite the visualAction in English; only narration uses the target language." }];
  if (!startsWithDirectionVerb(visualAction)) return [{ rule: "script-visual-action-non-directive", evidence: { visualAction }, remediation: "Start the visualAction with a visual-direction verb such as reveal, trace, or inspect." }];
  return [];
};

export const validateEntityDescriptionLanguage = (entity: { id: string; description: string }): MediaIssue[] =>
  isNonEnglishScript(entity.description) ? [{ rule: "bible-entity-description-localized", evidence: { entityId: entity.id }, remediation: "Rewrite the persistent entity description in English; it becomes part of the image prompt." }] : [];

export type ScriptLike = { narration: Array<{ id: string; text: string; visualAction: string }> };

export const validateScriptLanguageDirective = (script: ScriptLike, baselineNarration?: Map<string, string>): MediaIssue[] => {
  const issues: MediaIssue[] = script.narration.flatMap((line) => validateVisualActionLanguage(line.visualAction).map((issue) => ({ ...issue, evidence: { ...issue.evidence, lineId: line.id } })));
  if (baselineNarration) {
    const mutated = script.narration.filter((line) => baselineNarration.get(line.id) !== undefined && baselineNarration.get(line.id) !== line.text).map((line) => line.id);
    if (mutated.length) issues.push({ rule: "script-narration-mutated", evidence: { lineIds: mutated }, remediation: "Rewrite only visualAction; narration must stay verbatim during a language repair." });
  }
  return issues;
};

export const VISUAL_ACTION_CORRECTION_CONTRACT = "Keep the same schema and ids; preserve every narration text verbatim; rewrite only the listed lines' visualAction in English.";

export type LanguageCorrection = { attempt: number; lineIds: string[]; rationale: string; contract: string };
export type LanguageAttempt<T> = { attempt: number; outcome: "completed" | "rejected-by-language-directive"; issues: MediaIssue[]; value?: T };

export class ScriptLanguageDirectiveExhaustedError extends Error {
  public readonly code = SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED;
  public readonly attempts: LanguageAttempt<unknown>[];
  public constructor(attempts: LanguageAttempt<unknown>[]) {
    super(`${SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED}: visualAction language still failed after ${attempts.length} attempt(s)`);
    this.name = "ScriptLanguageDirectiveExhaustedError";
    this.attempts = attempts;
  }
}

export const runBoundedVisualActionLanguageLoop = async <T extends ScriptLike>(params: {
  generate: (correction: LanguageCorrection | null) => Promise<T>;
  maxAttempts?: number;
  onAttempt?: (attempt: LanguageAttempt<T>) => void;
}): Promise<{ value: T; attempts: LanguageAttempt<T>[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_LANGUAGE_DIRECTIVE_ATTEMPTS;
  const attempts: LanguageAttempt<T>[] = [];
  let correction: LanguageCorrection | null = null;
  let baseline: Map<string, string> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await params.generate(correction);
    baseline ??= new Map(generated.narration.map((line) => [line.id, line.text]));
    const issues = validateScriptLanguageDirective(generated, baseline);
    if (!issues.length) {
      const record: LanguageAttempt<T> = { attempt, outcome: "completed", issues: [], value: generated };
      attempts.push(record);
      params.onAttempt?.(record);
      return { value: generated, attempts };
    }
    const record: LanguageAttempt<T> = { attempt, outcome: "rejected-by-language-directive", issues };
    attempts.push(record);
    params.onAttempt?.(record);
    correction = { attempt: attempt + 1, lineIds: [...new Set(issues.flatMap((issue) => (typeof issue.evidence.lineId === "string" ? [issue.evidence.lineId] : [])))], rationale: issues.map((issue) => issue.rule).join(", "), contract: VISUAL_ACTION_CORRECTION_CONTRACT };
  }
  throw new ScriptLanguageDirectiveExhaustedError(attempts as LanguageAttempt<unknown>[]);
};

// --- W4: one caption geometry source of truth ---
export type Rect = { x: number; y: number; width: number; height: number };

export const CAPTION_WIDTH_SAFETY_MARGIN = 1.08;
export const DEFAULT_LONG_PAUSE_MS = 700;
export const MAX_CAPTION_SAFE_AREA_PAIR_SUM = 0.5;

export type ScriptClass = "latin" | "cyrillic-greek" | "arabic-hebrew" | "indic" | "cjk";

const SCRIPT_CLASS_PATTERNS: Array<[ScriptClass, RegExp]> = [
  ["cjk", /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u],
  ["indic", /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/u],
  ["arabic-hebrew", /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F]/u],
  ["cyrillic-greek", /[\u0370-\u03FF\u0400-\u04FF]/u],
];

export const SCRIPT_WIDTH_FACTOR: Record<ScriptClass, number> = {
  latin: 0.58,
  "cyrillic-greek": 0.6,
  "arabic-hebrew": 0.54,
  indic: 0.64,
  cjk: 0.95,
};

export const classifyScript = (value: string): ScriptClass => {
  for (const [scriptClass, pattern] of SCRIPT_CLASS_PATTERNS) if (pattern.test(value)) return scriptClass;
  return "latin";
};

export const captionWidthFactor = (value: string): number => SCRIPT_WIDTH_FACTOR[classifyScript(value)];
export const estimateCaptionWidth = (text: string, fontSize = CAPTION_FONT_SIZE, safetyMargin = CAPTION_WIDTH_SAFETY_MARGIN): number =>
  [...text].length * fontSize * captionWidthFactor(text) * safetyMargin;
export const captionLineCount = (text: string, contentWidth: number, fontSize = CAPTION_FONT_SIZE): number =>
  Math.max(1, Math.ceil(estimateCaptionWidth(text, fontSize) / Math.max(1, contentWidth)));

const captionContentWidth = (canvas: { width: number }, safeArea: CaptionSafeArea): number =>
  Math.min(CAPTION_MAX_WIDTH, canvas.width - Math.round(safeArea.left * canvas.width) - Math.round(safeArea.right * canvas.width)) - CAPTION_HORIZONTAL_PADDING * 2;

/** Static full-width band (what s13 checked); retained for comparison and tests. */
export const captionPanelRect = (canvas: { width: number; height: number }, safeArea: CaptionSafeArea): Rect => ({
  x: Math.round(safeArea.left * canvas.width),
  y: canvas.height - Math.round(safeArea.bottom * canvas.height),
  width: canvas.width - Math.round(safeArea.left * canvas.width) - Math.round(safeArea.right * canvas.width),
  height: Math.round(safeArea.bottom * canvas.height),
});

/**
 * The true per-scene caption block: only that scene's cues, wrapped at the
 * script-class width, bottom-anchored inside the safe band. With no scene range the
 * union over all cues is returned.
 */
export const captionZoneForScene = (params: {
  canvas: { width: number; height: number };
  safeArea: CaptionSafeArea;
  cues: CaptionCue[];
  words: WordTiming[];
  sceneWordRange?: { startWordIndex: number; endWordIndex: number };
}): Rect => {
  const { canvas, safeArea, cues } = params;
  const sceneCues = params.sceneWordRange
    ? cues.filter((cue) => cue.wordIndexes.some((index) => index >= params.sceneWordRange!.startWordIndex && index < params.sceneWordRange!.endWordIndex))
    : cues;
  const contentWidth = captionContentWidth(canvas, safeArea);
  const maxLines = sceneCues.length ? Math.max(...sceneCues.map((cue) => captionLineCount(cue.text, contentWidth))) : 0;
  const x = Math.round(safeArea.left * canvas.width);
  const width = canvas.width - x - Math.round(safeArea.right * canvas.width);
  const height = maxLines === 0 ? 0 : maxLines * CAPTION_FONT_SIZE * CAPTION_LINE_HEIGHT + CAPTION_VERTICAL_PADDING * 2;
  return { x, y: canvas.height - Math.round(safeArea.bottom * canvas.height) - height, width, height };
};

export const validateCaptionSafeArea = (safeArea: { top: number; right: number; bottom: number; left: number }): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  for (const [edge, value] of Object.entries(safeArea)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) issues.push({ rule: "bible-safe-area-edge-bound", evidence: { edge, value, min: 0, max: 1 }, remediation: "Express each caption safe-area margin as a fraction between 0 and 1." });
  }
  if (safeArea.top + safeArea.bottom > MAX_CAPTION_SAFE_AREA_PAIR_SUM) issues.push({ rule: "bible-safe-area-vertical-overflow", evidence: { top: safeArea.top, bottom: safeArea.bottom, maxSum: MAX_CAPTION_SAFE_AREA_PAIR_SUM }, remediation: "Reduce the top/bottom margins so the caption block keeps at least half the canvas height." });
  if (safeArea.left + safeArea.right > MAX_CAPTION_SAFE_AREA_PAIR_SUM) issues.push({ rule: "bible-safe-area-horizontal-overflow", evidence: { left: safeArea.left, right: safeArea.right, maxSum: MAX_CAPTION_SAFE_AREA_PAIR_SUM }, remediation: "Reduce the left/right margins so the caption block keeps at least half the canvas width." });
  return issues;
};

export type SceneWordRange = { startWordIndex: number; endWordIndex: number };
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export const lineBoundaryIndexes = (narration: Array<{ text: string }>): number[] => {
  const boundaries: number[] = [];
  let cursor = 0;
  for (const line of narration) {
    boundaries.push(cursor);
    cursor += wordCount(line.text);
  }
  return boundaries;
};

export const sceneWordRanges = (narration: Array<{ sceneId: string; text: string }>): Map<string, SceneWordRange> => {
  let cursor = 0;
  const ranges = new Map<string, SceneWordRange>();
  for (const line of narration) {
    const count = wordCount(line.text);
    const current = ranges.get(line.sceneId);
    ranges.set(line.sceneId, {
      startWordIndex: current ? Math.min(current.startWordIndex, cursor) : cursor,
      endWordIndex: Math.max(current?.endWordIndex ?? 0, cursor + count),
    });
    cursor += count;
  }
  return ranges;
};

/**
 * Width/boundary/pause-aware cue packing. A cue never straddles a script-line
 * boundary or a reserved inspection pause, so caption<->scene attribution stays
 * exact for per-scene zone logic.
 */
export const packCaptionCues = (params: {
  words: WordTiming[];
  lineBoundaries?: number[];
  sceneBoundaries?: number[];
  maxWords?: number;
  maxCueWidth?: number;
  fontSize?: number;
  longPauseMs?: number;
  contentWidth?: number;
}): CaptionCue[] => {
  const maxWords = params.maxWords ?? CAPTION_MAX_WORDS;
  const longPauseMs = params.longPauseMs ?? DEFAULT_LONG_PAUSE_MS;
  const contentWidth = params.contentWidth ?? CAPTION_MAX_WIDTH - CAPTION_HORIZONTAL_PADDING * 2;
  const maxCueWidth = params.maxCueWidth ?? contentWidth;
  const startsNewCue = new Set([...(params.lineBoundaries ?? []), ...(params.sceneBoundaries ?? [])]);
  const cues: CaptionCue[] = [];
  let current: CaptionCue | undefined;
  for (let index = 0; index < params.words.length; index += 1) {
    const word = params.words[index]!;
    const previous = index > 0 ? params.words[index - 1]! : undefined;
    const boundary = startsNewCue.has(index);
    const longPause = previous ? word.startMs - previous.endMs >= longPauseMs : false;
    const candidateText = current ? `${current.text} ${word.text}` : word.text;
    const overBudget = current ? current.wordIndexes.length + 1 > maxWords || estimateCaptionWidth(candidateText, params.fontSize) > maxCueWidth : false;
    if (!current || boundary || longPause || overBudget) {
      current = { text: word.text, startMs: word.startMs, endMs: word.endMs, wordIndexes: [index] };
      cues.push(current);
    } else {
      current.text = candidateText;
      current.endMs = word.endMs;
      current.wordIndexes.push(index);
    }
  }
  return cues;
};

const rectIntersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** s10 assertion: every solver layer must clear its scene's computed caption zone. */
export const validateCaptionZoneClearance = (params: {
  layouts: Array<{ sceneId: string; layers: Array<{ id: string; bounds: Rect }> }>;
  zones: Map<string, Rect>;
}): MediaIssue[] => {
  const issues: MediaIssue[] = [];
  for (const layout of params.layouts) {
    const zone = params.zones.get(layout.sceneId);
    if (!zone || zone.width <= 0 || zone.height <= 0) continue;
    for (const layer of layout.layers) {
      if (rectIntersects(layer.bounds, zone)) issues.push({ rule: "spatial-caption-overlap", evidence: { sceneId: layout.sceneId, layerId: layer.id, bounds: layer.bounds, captionZone: zone }, remediation: "Re-solve the overlay so diagram layers clear the computed caption zone." });
    }
  }
  return issues;
};

/** N9 invariant: every narrated scene has exactly one selected diagram asset. */
export const validateOneDiagramPerScene = (params: {
  sceneIds: string[];
  assets: Array<{ sceneId?: string | null; role: string }>;
}): MediaIssue[] =>
  params.sceneIds.flatMap((sceneId) => {
    const matches = params.assets.filter((asset) => asset.sceneId === sceneId && asset.role === `diagram-${sceneId}`);
    return matches.length === 1 ? [] : [{ rule: "scene-diagram-invariant", evidence: { sceneId, count: matches.length }, remediation: "Produce exactly one selected diagram asset per narrated scene." }];
  });
