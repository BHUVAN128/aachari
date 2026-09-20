import { createHash } from "node:crypto";
import {
  SourceEvidenceMapSchema,
  type SourceSegment,
} from "@upcraft/contracts";

/**
 * Gap 3 — semantic segmentation (test-local first; promoted at Phase 6).
 *
 * The production `buildSourceEvidenceMap` cuts a source at a fixed 6000-character
 * target and falls back to the nearest whitespace. That can slice a sentence (or a
 * definition) in half, so a claim whose evidence lives in that sentence can never
 * cite a token that contains it. This module replaces the boundary choice with a
 * sentence-aware search and adds marked overlap context, without changing the
 * lossless-join guarantee for primary segments.
 *
 * Contract:
 *   - primary segments tile the source exactly: primary.join("") === text
 *   - offsets are monotonic and non-overlapping for primary segments
 *   - each boundary (except the last) ends at a sentence terminator when one is
 *     found inside the lookahead window, else at whitespace, else a hard cut
 *   - overlap segments duplicate a read-only lookback window, are marked
 *     `overlap: true`, and are valid citation targets
 */

export const SEGMENT_TARGET_SIZE = 6_000;
export const OVERLAP_CONTEXT_CHARS = 300;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export type SemanticSegment = SourceSegment & { overlap: boolean };

const SENTENCE_END = /[.!?](?=\s|$)|(?:\r?\n){2}/g;

/**
 * Finds the best end offset for a boundary that starts at `start` and would
 * otherwise cut at `cap`. Preference order:
 *   1. the last sentence terminator within the lookahead window (>= minKeep)
 *   2. the last sentence terminator anywhere in [start, cap]
 *   3. the last whitespace at or before cap (>= minKeep)
 *   4. the hard cap
 */
export const chooseBoundary = (text: string, start: number, cap: number, options: { minKeep?: number; lookahead?: number } = {}): number => {
  if (cap >= text.length) return text.length;
  const minKeep = options.minKeep ?? 1_000;
  const lookahead = options.lookahead ?? 400;
  const windowEnd = Math.min(cap + lookahead, text.length);

  const sentenceBoundary = (from: number, to: number): number | undefined => {
    SENTENCE_END.lastIndex = 0;
    let best: number | undefined;
    let match: RegExpExecArray | null;
    const slice = text.slice(0, to);
    while ((match = SENTENCE_END.exec(slice)) !== null) {
      const end = match.index + match[0].length;
      if (end > from && end <= to) best = end;
    }
    return best !== undefined && best > start + minKeep ? best : undefined;
  };

  const lookaheadBoundary = sentenceBoundary(cap, windowEnd);
  if (lookaheadBoundary !== undefined) return lookaheadBoundary;
  const cappedBoundary = sentenceBoundary(start + minKeep, cap);
  if (cappedBoundary !== undefined) return cappedBoundary;

  const whitespace = text.lastIndexOf(" ", cap);
  if (whitespace > start + minKeep) return whitespace + 1;
  return cap;
};

/**
 * Builds a source-evidence map with sentence-aware primary segments plus marked
 * overlap segments. Primary segments alone must still join losslessly to the
 * source; overlap segments are additive citation evidence only.
 */
export const buildSourceEvidenceMapWithOverlap = (
  sources: Array<{ id: string; sha256: string; extractedText: string | null }>,
): { map: ReturnType<typeof SourceEvidenceMapSchema.parse>; overlaps: SemanticSegment[]; primaryJoin: string } => {
  const allOverlaps: SemanticSegment[] = [];
  let primaryJoin = "";

  const map = SourceEvidenceMapSchema.parse({
    schemaVersion: "source-evidence-map/v1",
    sources: sources.map((source) => {
      if (!source.extractedText) throw new Error(`Source ${source.id} has no locked extracted text`);
      const text = source.extractedText;
      if (text.length === 0) {
        const segment: SourceSegment = { id: sha(`${source.id}:${source.sha256}:0:0`), sourceId: source.id, sourceHash: source.sha256, ordinal: 0, startOffset: 0, endOffset: 0, text: "" };
        primaryJoin += "";
        return { sourceId: source.id, sourceHash: source.sha256, segments: [segment] };
      }

      const segments: SourceSegment[] = [];
      const overlaps: SemanticSegment[] = [];
      let start = 0;
      let ordinal = 0;
      while (start < text.length) {
        const cap = Math.min(start + SEGMENT_TARGET_SIZE, text.length);
        const end = chooseBoundary(text, start, cap);
        segments.push({ id: sha(`${source.id}:${source.sha256}:${start}:${end}`), sourceId: source.id, sourceHash: source.sha256, ordinal, startOffset: start, endOffset: end, text: text.slice(start, end) });
        if (start > 0) {
          const overlapStart = Math.max(0, start - OVERLAP_CONTEXT_CHARS);
          overlaps.push({ id: sha(`${source.id}:${source.sha256}:overlap:${overlapStart}:${start}`), sourceId: source.id, sourceHash: source.sha256, ordinal, startOffset: overlapStart, endOffset: start, text: text.slice(overlapStart, start), overlap: true });
        }
        start = end;
        ordinal += 1;
      }
      const joined = segments.map((segment) => segment.text).join("");
      if (joined !== text) throw new Error(`Source segmentation lost bytes for ${source.id}`);
      primaryJoin = joined;
      allOverlaps.push(...overlaps);
      return { sourceId: source.id, sourceHash: source.sha256, segments };
    }),
  });

  return { map, overlaps: allOverlaps, primaryJoin };
};

/** Resolves primary or overlap segment ids against a map, used by citation checks. */
export const resolveSegments = (
  map: { sources: Array<{ sourceId: string; sourceHash: string; segments: SourceSegment[] }> },
  overlaps: SemanticSegment[],
  refs: Array<{ sourceId: string; sourceHash: string; segmentIds: string[] }>,
): SemanticSegment[] => {
  const pool = new Map<string, SemanticSegment>();
  for (const source of map.sources) for (const segment of source.segments) pool.set(segment.id, { ...segment, overlap: false });
  for (const overlap of overlaps) pool.set(overlap.id, overlap);
  const resolved: SemanticSegment[] = [];
  for (const ref of refs) {
    const source = map.sources.find((candidate) => candidate.sourceId === ref.sourceId && candidate.sourceHash === ref.sourceHash);
    if (!source) throw new Error(`Evidence source ${ref.sourceId} is not in the locked source map`);
    for (const id of ref.segmentIds) {
      const segment = pool.get(id);
      if (!segment) throw new Error(`Evidence segment ${id} is not in the locked source map`);
      resolved.push(segment);
    }
  }
  return [...new Map(resolved.map((segment) => [segment.id, segment])).values()];
};

/** Context manifest metadata contributed by segmentation: primary and overlap counts. */
export const segmentationManifest = (map: ReturnType<typeof SourceEvidenceMapSchema.parse>, overlaps: SemanticSegment[]) => ({
  primarySegments: map.sources.reduce((sum, source) => sum + source.segments.length, 0),
  overlapSegments: overlaps.length,
  overlapChars: overlaps.reduce((sum, segment) => sum + segment.text.length, 0),
});