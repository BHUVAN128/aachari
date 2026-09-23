import { createHash } from "node:crypto";
import {
  SourceEvidenceMapSchema,
  type ApprovedScript,
  type FactPack,
  type SourceEvidenceMap,
  type SourceSegment,
} from "@upcraft/contracts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Gap 3 — semantic segmentation, promoted from the s02 sandbox.
 *
 * A source is cut on sentence boundaries (falling back to whitespace, then a hard
 * cap) rather than at a fixed character target, so a definition that straddles the
 * boundary stays inside one segment. Primary segments still tile the source
 * losslessly; marked overlap segments are additive citation evidence only.
 */
export const SEGMENT_TARGET_SIZE = 6_000;
export const OVERLAP_CONTEXT_CHARS = 300;

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

/** Split without dropping or normalizing source bytes. Offsets are UTF-16 offsets, matching JS strings. */
export const buildSourceEvidenceMap = (sources: Array<{ id: string; sha256: string; extractedText: string | null }>) => SourceEvidenceMapSchema.parse({
  schemaVersion: "source-evidence-map/v1",
  sources: sources.map((source) => {
    if (!source.extractedText) throw new Error(`Source ${source.id} has no locked extracted text`);
    const text = source.extractedText;
    const segments: SourceSegment[] = [];
    let start = 0;
    let ordinal = 0;
    while (start < text.length || (text.length === 0 && ordinal === 0)) {
      if (text.length === 0) {
        segments.push({ id: sha(`${source.id}:${source.sha256}:0:0`), sourceId: source.id, sourceHash: source.sha256, ordinal: 0, startOffset: 0, endOffset: 0, text: "" });
        break;
      }
      const cap = Math.min(start + SEGMENT_TARGET_SIZE, text.length);
      const end = chooseBoundary(text, start, cap);
      const segmentText = text.slice(start, end);
      segments.push({ id: sha(`${source.id}:${source.sha256}:${start}:${end}`), sourceId: source.id, sourceHash: source.sha256, ordinal, startOffset: start, endOffset: end, text: segmentText });
      start = end;
      ordinal += 1;
    }
    if (segments.map((segment) => segment.text).join("") !== text) throw new Error(`Source segmentation lost bytes for ${source.id}`);
    return { sourceId: source.id, sourceHash: source.sha256, segments };
  }),
});

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
export const segmentationManifest = (map: { sources: Array<{ segments: SourceSegment[] }> }, overlaps: SemanticSegment[]) => ({
  primarySegments: map.sources.reduce((sum, source) => sum + source.segments.length, 0),
  overlapSegments: overlaps.length,
  overlapChars: overlaps.reduce((sum, segment) => sum + segment.text.length, 0),
});

export const sourceEvidenceSegments = (map: SourceEvidenceMap, refs: Array<{ sourceId: string; sourceHash: string; segmentIds: string[] }>) => {
  const segments: SourceSegment[] = [];
  for (const ref of refs) {
    const source = map.sources.find((candidate) => candidate.sourceId === ref.sourceId && candidate.sourceHash === ref.sourceHash);
    if (!source) throw new Error(`Evidence source ${ref.sourceId} is not in the locked source map`);
    for (const segmentId of ref.segmentIds) {
      const segment = source.segments.find((candidate) => candidate.id === segmentId);
      if (!segment) throw new Error(`Evidence segment ${segmentId} is not in the locked source map`);
      segments.push(segment);
    }
  }
  return [...new Map(segments.map((segment) => [segment.id, segment])).values()];
};

export const canonicalNarrationText = (script: Pick<ApprovedScript, "narration">) => script.narration.map((line) => line.text.trim()).join("\n\n");

export const projectFactVerificationContext = (factPack: FactPack, map: SourceEvidenceMap) => ({
  schemaVersion: "fact-verification-context/v1",
  claims: factPack.claims,
  evidenceSegments: sourceEvidenceSegments(map, factPack.claims.map((claim) => claim.evidence)),
});

export const projectScriptContext = (factPack: FactPack, blueprint: { scenes: Array<{ id: string; claimIds: string[] }> }) => {
  const claimIds = new Set(blueprint.scenes.flatMap((scene) => scene.claimIds));
  return {
    schemaVersion: "script-context/v1",
    scenes: blueprint.scenes,
    claims: factPack.claims.filter((claim) => claimIds.has(claim.id)),
    caveats: factPack.caveats,
  };
};

export const projectVisualContext = (script: Pick<ApprovedScript, "narration">) => ({
  schemaVersion: "visual-context/v1",
  narration: script.narration.map(({ sceneId, text, visualAction }) => ({ sceneId, text, visualAction })),
});

export const contextManifest = (projection: string, inputs: Array<{ role: string; hash: string; chars: number; itemCount?: number }>) => ({
  projection,
  inputs: inputs.map((input) => ({ ...input })),
  totalChars: inputs.reduce((sum, input) => sum + input.chars, 0),
});
