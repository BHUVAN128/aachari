import { z } from "zod";
import type { CaptionCue, WordTiming } from "@upcraft/contracts";

/**
 * W4 — caption geometry as one source of truth (test-local first; promoted into
 * `packages/contracts`, `packages/pipeline/src/media-qa.ts`, and the s06/s09/s10
 * handlers at Phase 6).
 *
 * Today three disconnected geometry sources disagree and only s13 — after the
 * preview render spend — detects it:
 *   - `scene-area.ts` hardcodes the diagram bottom edge at `0.28 + 0.48 = 0.76`;
 *   - the s06 bible's `captionSafeArea.bottom` is a model-chosen fraction with no
 *     upper bound (`z.number().min(0)`), so `bottom: 0.30` is accepted;
 *   - `spatialQa` (qa-branches.ts) checks a static full-width band of height
 *     `safeArea.bottom` only at s13.
 * A `bottom: 0.30` bible therefore guarantees a Tier A `spatial-caption-overlap`
 * that dies at s13 with no repair path. Caption line wrapping is also estimated
 * with a Latin-calibrated `len * fontSize * 0.58`, which mis-counts Tamil,
 * Devanagari, Arabic, or German-compound text.
 *
 * This module: (1) bounds the safe-area schema at s06 pre-save; (2) derives the
 * true per-scene caption zone with a script-class width factor; (3) packs cues
 * width-aware, breaking them at script-line boundaries and long pauses; and
 * (4) lets s10 assert solver layers clear the computed zone at zero token cost.
 */

export type QaIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Caption geometry constants mirroring `media-qa.ts` / the composition. These must
 * stay in lockstep with the renderer or the gate measures something not rendered.
 */
export const CAPTION_FONT_SIZE = 58;
export const CAPTION_LINE_HEIGHT = 1.12;
export const CAPTION_HORIZONTAL_PADDING = 34;
export const CAPTION_VERTICAL_PADDING = 20;
export const CAPTION_MAX_WIDTH = 1300;
export const CAPTION_MAX_WORDS = 8;
export const CAPTION_WIDTH_SAFETY_MARGIN = 1.08;
export const DEFAULT_LONG_PAUSE_MS = 700;

export const MAX_SAFE_AREA_EDGE = 1;
export const MAX_SAFE_AREA_PAIR_SUM = 0.5;

export const CaptionSafeAreaSchema = z
  .object({
    top: z.number().min(0).max(MAX_SAFE_AREA_EDGE),
    right: z.number().min(0).max(MAX_SAFE_AREA_EDGE),
    bottom: z.number().min(0).max(MAX_SAFE_AREA_EDGE),
    left: z.number().min(0).max(MAX_SAFE_AREA_EDGE),
  })
  .refine((area) => area.top + area.bottom <= MAX_SAFE_AREA_PAIR_SUM, { message: "top + bottom caption safe-area margins must not exceed 0.5" })
  .refine((area) => area.left + area.right <= MAX_SAFE_AREA_PAIR_SUM, { message: "left + right caption safe-area margins must not exceed 0.5" });

export type CaptionSafeArea = z.infer<typeof CaptionSafeAreaSchema>;

/**
 * Deterministic safe-area gate run at s06 before the artifact is saved, so the
 * s11 late-throw (`value > 1`) and the s13 collision can no longer happen.
 */
export const validateCaptionSafeArea = (safeArea: { top: number; right: number; bottom: number; left: number }): QaIssue[] => {
  const issues: QaIssue[] = [];
  for (const [edge, value] of Object.entries(safeArea)) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_SAFE_AREA_EDGE) {
      issues.push({ rule: "bible-safe-area-edge-bound", evidence: { edge, value, min: 0, max: MAX_SAFE_AREA_EDGE }, remediation: "Express each caption safe-area margin as a fraction between 0 and 1." });
    }
  }
  if (safeArea.top + safeArea.bottom > MAX_SAFE_AREA_PAIR_SUM) {
    issues.push({ rule: "bible-safe-area-vertical-overflow", evidence: { top: safeArea.top, bottom: safeArea.bottom, maxSum: MAX_SAFE_AREA_PAIR_SUM }, remediation: "Reduce the top/bottom margins so the caption block keeps at least half the canvas height." });
  }
  if (safeArea.left + safeArea.right > MAX_SAFE_AREA_PAIR_SUM) {
    issues.push({ rule: "bible-safe-area-horizontal-overflow", evidence: { left: safeArea.left, right: safeArea.right, maxSum: MAX_SAFE_AREA_PAIR_SUM }, remediation: "Reduce the left/right margins so the caption block keeps at least half the canvas width." });
  }
  return issues;
};

export type ScriptClass = "latin" | "cyrillic-greek" | "arabic-hebrew" | "indic" | "cjk";

const SCRIPT_CLASS_PATTERNS: Array<[ScriptClass, RegExp]> = [
  ["cjk", /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u],
  ["indic", /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/u],
  ["arabic-hebrew", /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F]/u],
  ["cyrillic-greek", /[\u0370-\u03FF\u0400-\u04FF]/u],
];

/**
 * Per-script width factor as a multiple of the Latin `len * fontSize * 0.58`
 * calibration. Latin stays exactly 0.58 so the compositor baseline is preserved;
 * every other class is expressed relative to it.
 */
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

/** Script-class-corrected, margin-padded text width for caption wrapping. */
export const estimateCaptionWidth = (text: string, fontSize = CAPTION_FONT_SIZE, safetyMargin = CAPTION_WIDTH_SAFETY_MARGIN): number =>
  [...text].length * fontSize * captionWidthFactor(text) * safetyMargin;

export const captionLineCount = (text: string, contentWidth: number, fontSize = CAPTION_FONT_SIZE): number =>
  Math.max(1, Math.ceil(estimateCaptionWidth(text, fontSize) / Math.max(1, contentWidth)));

const contentWidthFor = (canvas: { width: number }, safeArea: CaptionSafeArea): number => {
  const leftPx = Math.round(safeArea.left * canvas.width);
  const rightPx = Math.round(safeArea.right * canvas.width);
  return Math.min(CAPTION_MAX_WIDTH, canvas.width - leftPx - rightPx) - CAPTION_HORIZONTAL_PADDING * 2;
};

/** The static full-width band s13 checks today; kept for parity and comparison. */
export const captionPanelRect = (canvas: { width: number; height: number }, safeArea: CaptionSafeArea): Rect => ({
  x: Math.round(safeArea.left * canvas.width),
  y: canvas.height - Math.round(safeArea.bottom * canvas.height),
  width: canvas.width - Math.round(safeArea.left * canvas.width) - Math.round(safeArea.right * canvas.width),
  height: Math.round(safeArea.bottom * canvas.height),
});

/**
 * The true per-scene caption block: only the cues that belong to the scene,
 * wrapped at the script-class width, occupying the minimum rectangle the renderer
 * will actually paint. Without a `sceneWordRange` the union over every cue is
 * returned (usable before scene ranges are known).
 */
export const captionZoneForScene = (params: {
  canvas: { width: number; height: number };
  safeArea: CaptionSafeArea;
  cues: CaptionCue[];
  words: WordTiming[];
  sceneWordRange?: { startWordIndex: number; endWordIndex: number };
}): Rect => {
  const { canvas, safeArea, cues, words } = params;
  const sceneCues = params.sceneWordRange
    ? cues.filter((cue) => cue.wordIndexes.some((index) => index >= params.sceneWordRange!.startWordIndex && index < params.sceneWordRange!.endWordIndex))
    : cues;
  const contentWidth = contentWidthFor(canvas, safeArea);
  const maxLines = sceneCues.length ? Math.max(...sceneCues.map((cue) => captionLineCount(cue.text, contentWidth))) : 0;
  const x = Math.round(safeArea.left * canvas.width);
  const panelWidth = canvas.width - x - Math.round(safeArea.right * canvas.width);
  const height = maxLines === 0 ? 0 : maxLines * CAPTION_FONT_SIZE * CAPTION_LINE_HEIGHT + CAPTION_VERTICAL_PADDING * 2;
  // Captions are bottom-anchored inside the safe band, so the occupied block grows
  // upward from the bottom margin — a block taller than the band overflows into the
  // top margin and is caught by the clearance assertion.
  return { x, y: canvas.height - Math.round(safeArea.bottom * canvas.height) - height, width: panelWidth, height };
};

export type SceneWordRange = { startWordIndex: number; endWordIndex: number };

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Word index at which each script line begins, using the same cursor pattern s11
 * uses. Feeding these to `packCaptionCues` keeps a cue inside exactly one line.
 */
export const lineBoundaryIndexes = (narration: Array<{ text: string }>): number[] => {
  const boundaries: number[] = [];
  let cursor = 0;
  for (const line of narration) {
    boundaries.push(cursor);
    cursor += wordCount(line.text);
  }
  return boundaries;
};

/** Merges per-line ranges into per-scene ranges (a scene may span several lines). */
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

export type PackedCue = CaptionCue;

/**
 * Width-aware, boundary-aware cue packing. A new cue starts at every script-line
 * boundary and after any inter-word gap of at least `longPauseMs` (a reserved
 * diagram-inspection pause), and whenever adding the next word would exceed the
 * word or width budget. A cue therefore never straddles a pause or a line, so
 * caption/scene attribution stays exact for per-scene zone logic.
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
}): PackedCue[] => {
  const maxWords = params.maxWords ?? CAPTION_MAX_WORDS;
  const longPauseMs = params.longPauseMs ?? DEFAULT_LONG_PAUSE_MS;
  const contentWidth = params.contentWidth ?? CAPTION_MAX_WIDTH - CAPTION_HORIZONTAL_PADDING * 2;
  const maxCueWidth = params.maxCueWidth ?? contentWidth;
  const startsNewCue = new Set([...(params.lineBoundaries ?? []), ...(params.sceneBoundaries ?? [])]);
  const cues: PackedCue[] = [];
  let current: PackedCue | undefined;
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

/**
 * s10 solver assertion: every layout layer must clear its scene's computed caption
 * zone. Failures surface at s10 (zero tokens) instead of a critical Tier A finding
 * at s13, after assets, TTS, and the preview render have already been paid for.
 */
export const validateCaptionZoneClearance = (params: {
  layouts: Array<{ sceneId: string; layers: Array<{ id: string; bounds: Rect }> }>;
  zones: Map<string, Rect>;
}): QaIssue[] => {
  const issues: QaIssue[] = [];
  for (const layout of params.layouts) {
    const zone = params.zones.get(layout.sceneId);
    if (!zone || zone.width <= 0 || zone.height <= 0) continue;
    for (const layer of layout.layers) {
      if (rectIntersects(layer.bounds, zone)) {
        issues.push({ rule: "spatial-caption-overlap", evidence: { sceneId: layout.sceneId, layerId: layer.id, bounds: layer.bounds, captionZone: zone }, remediation: "Re-solve the overlay so diagram layers clear the computed caption zone." });
      }
    }
  }
  return issues;
};

/**
 * N9 invariant: every narrated scene must have exactly one selected diagram asset.
 * `s10` throws per scene today, but nothing upstream asserts the invariant; this
 * makes a missing or duplicate diagram a deterministic, surfaced finding.
 */
export const validateOneDiagramPerScene = (params: {
  sceneIds: string[];
  assets: Array<{ sceneId?: string | null; role: string }>;
}): QaIssue[] =>
  params.sceneIds.flatMap((sceneId) => {
    const matches = params.assets.filter((asset) => asset.sceneId === sceneId && asset.role === `diagram-${sceneId}`);
    if (matches.length === 1) return [];
    return [{ rule: "scene-diagram-invariant", evidence: { sceneId, count: matches.length }, remediation: "Produce exactly one selected diagram asset per narrated scene." }];
  });
