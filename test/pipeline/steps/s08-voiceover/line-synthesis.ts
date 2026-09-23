import type { WordTiming } from "@upcraft/contracts";

/**
 * Gap 2 — line-structured TTS synthesis and alignment (test-local first;
 * promoted at Phase 6).
 *
 * The narration is currently synthesized as one flat string
 * (`canonicalNarrationText` joins lines with "\n\n" but no pause is requested).
 * This module gives each approved line a deterministic break marker, synthesizes
 * the structured text, and maps ElevenLabs character alignment back to words
 * across those break markers — correcting the offset shift and asserting that the
 * resulting timestamps are monotonic. Promotion moves this into
 * `packages/providers/src/elevenlabs.ts` and `packages/pipeline/src/context.ts`.
 */
export const LINE_BREAK = "\n\n";

/** Deterministic structured narration: one segment per approved line. */
export const buildLineStructuredNarration = (lines: string[], breakMarker = LINE_BREAK): string =>
  lines.map((line) => line.trim()).filter(Boolean).join(breakMarker);

export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export type AlignmentBreak = { afterWordIndex: number; offset: number; text: string };

export type MappedAlignment = {
  words: WordTiming[];
  breaks: AlignmentBreak[];
};

const isBreakChar = (value: string, breakMarker: string) => breakMarker.includes(value);

/**
 * Maps a character alignment to word timings, treating the break marker as a word
 * separator and recording where each structured line boundary falls. Timestamps
 * are asserted monotonic: a non-monotonic alignment is a transport/alignment
 * defect, not a valid narration.
 */
export const mapAlignmentToWords = (alignment: Alignment, breakMarker = LINE_BREAK): MappedAlignment => {
  const words: WordTiming[] = [];
  const breaks: AlignmentBreak[] = [];
  let start = 0;
  for (let index = 0; index <= alignment.characters.length; index += 1) {
    const atEnd = index === alignment.characters.length;
    const char = alignment.characters[index] ?? "";
    const previous = index > 0 ? (alignment.characters[index - 1] ?? "") : "";
    // Count a multi-character marker once, at its first character.
    const isBreak = !atEnd && isBreakChar(char, breakMarker) && !isBreakChar(previous, breakMarker);
    const isSeparator = atEnd || isBreak || /\s/.test(char);
    if (!isSeparator) continue;
    if (index > start) {
      const text = alignment.characters.slice(start, index).join("");
      const startSeconds = alignment.character_start_times_seconds[start];
      const endSeconds = alignment.character_end_times_seconds[index - 1];
      if (text && startSeconds !== undefined && endSeconds !== undefined) {
        words.push({ text, startMs: Math.floor(startSeconds * 1000), endMs: Math.ceil(endSeconds * 1000) });
      }
    }
    if (isBreak) breaks.push({ afterWordIndex: words.length, offset: index, text: char });
    start = index + 1;
  }
  return { words, breaks };
};

export type AlignmentIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

/** Monotonic timestamp gate for mapped words. */
export const validateMonotonicWords = (words: WordTiming[]): AlignmentIssue[] => {
  const issues: AlignmentIssue[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.endMs <= word.startMs) {
      issues.push({ rule: "alignment-word-nonpositive", evidence: { index, word }, remediation: "Re-map from the rendered narration; a zero-length word is a transport defect." });
    }
    if (index > 0 && word.startMs < words[index - 1]!.endMs) {
      issues.push({ rule: "alignment-non-monotonic", evidence: { index, previousEndMs: words[index - 1]!.endMs, startMs: word.startMs }, remediation: "Correct the break-offset mapping so timestamps never move backwards." });
    }
  }
  return issues;
};

/**
 * The number of line boundaries observed must match the number of structured
 * lines minus one; a missing boundary means a break was dropped by the transport.
 */
export const validateBreakCount = (breaks: AlignmentBreak[], lineCount: number): AlignmentIssue[] => {
  if (lineCount > 1 && breaks.length !== lineCount - 1) {
    return [{ rule: "alignment-break-count", evidence: { breaks: breaks.length, expected: lineCount - 1 }, remediation: "Re-synthesize the line-structured narration so every line boundary is present in the alignment." }];
  }
  return [];
};

export const mapStructuredAlignment = (alignment: Alignment, lines: string[]): MappedAlignment & { issues: AlignmentIssue[] } => {
  const mapped = mapAlignmentToWords(alignment, LINE_BREAK);
  const issues = [...validateMonotonicWords(mapped.words), ...validateBreakCount(mapped.breaks, lines.length)];
  return { ...mapped, issues };
};

/**
 * W5 — deterministic pause execution (test-local first; promoted into
 * `packages/providers/src/elevenlabs.ts`, `packages/pipeline/src/context.ts`, and
 * the s08 handler at Phase 6).
 *
 * `canonicalNarrationText` joins lines with "\n\n" and `ScriptLineSchema` has no
 * `pauseMs`, so production reserves no pause for diagram inspection at all. This
 * builds structured narration with an explicit, deterministic SSML break derived
 * from `pauseMs` (never a free-form marker), then measures the inter-line silence
 * in the returned alignment and fails if the break was not rendered. Repairs stay
 * retries; timestamps are never healed.
 */
export type PacedLine = { text: string; pauseMs?: number };

/** `<break time="2.000s"/>`; empty for a line with no reserved pause. */
export const pauseBreakTag = (pauseMs: number): string => (pauseMs > 0 ? `<break time="${(pauseMs / 1000).toFixed(3)}s"/>` : "");

const PAUSE_TAG_PATTERN = /<break\s+time="[\d.]+s"\s*\/>/g;

/** Removes pause tags before word-count/alignment comparison. */
export const stripPauseTags = (text: string): string => text.replace(PAUSE_TAG_PATTERN, "");

/** Deterministic structured narration: one spoken segment plus its break per line. */
export const buildPacedLineStructuredNarration = (lines: PacedLine[], breakMarker = LINE_BREAK): string =>
  lines.map((line) => `${line.text.trim()}${pauseBreakTag(line.pauseMs ?? 0)}`).join(breakMarker);

const countWords = (text: string) => stripPauseTags(text).trim().split(/\s+/).filter(Boolean).length;

/**
 * Measured-gap gate. Splits the alignment at the known per-line word counts and
 * asserts the silence between line N and line N+1 is at least the pause reserved
 * after line N (minus tolerance). A rendered break that the transport dropped is
 * visible here instead of silently collapsing the visual dwell.
 */
export const validateMeasuredBreaks = (params: { lines: PacedLine[]; words: WordTiming[]; toleranceMs?: number }): AlignmentIssue[] => {
  const tolerance = params.toleranceMs ?? 150;
  const issues: AlignmentIssue[] = [];
  let cursor = 0;
  for (let index = 0; index < params.lines.length; index += 1) {
    const line = params.lines[index]!;
    const count = countWords(line.text);
    const first = params.words[cursor];
    const last = params.words[cursor + count - 1];
    if (count > 0 && (!first || !last)) {
      issues.push({ rule: "alignment-line-missing", evidence: { lineIndex: index, text: line.text }, remediation: "Re-synthesize; every structured line must appear in the alignment." });
      return issues;
    }
    const pauseMs = line.pauseMs ?? 0;
    const nextLine = params.lines[index + 1];
    if (pauseMs > 0 && nextLine && last) {
      const nextFirst = params.words[cursor + count];
      const required = pauseMs - tolerance;
      const measured = nextFirst ? nextFirst.startMs - last.endMs : -Infinity;
      if (measured < required) {
        issues.push({ rule: "voice-pause-not-rendered", evidence: { lineIndex: index, pauseMs, measuredMs: Number.isFinite(measured) ? measured : null, requiredMs: required }, remediation: "Re-synthesize with the structured break; the reserved inspection pause was not rendered." });
      }
    }
    cursor += count;
  }
  return issues;
};