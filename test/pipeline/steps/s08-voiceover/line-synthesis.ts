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