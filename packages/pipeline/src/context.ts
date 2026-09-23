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

/**
 * Persists overlap context alongside primary segments in one locked map. Primary
 * segments keep their lossless tiling; overlap segments are appended marked
 * (`overlap: true`) and are citable evidence. Used by s02 so a claim that lands on
 * the context around a boundary can cite it without duplicating source bytes.
 */
export const mergeOverlapSegments = (
  map: ReturnType<typeof SourceEvidenceMapSchema.parse>,
  overlaps: SemanticSegment[],
): ReturnType<typeof SourceEvidenceMapSchema.parse> => {
  if (!overlaps.length) return map;
  const bySource = new Map<string, SemanticSegment[]>();
  for (const overlap of overlaps) {
    const list = bySource.get(overlap.sourceId) ?? [];
    list.push(overlap);
    bySource.set(overlap.sourceId, list);
  }
  return SourceEvidenceMapSchema.parse({
    schemaVersion: "source-evidence-map/v1",
    sources: map.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceHash: source.sourceHash,
      segments: [...source.segments, ...(bySource.get(source.sourceId) ?? [])]
        .map((segment) => ({ ...segment, overlap: "overlap" in segment ? segment.overlap === true : false }))
        .sort((a, b) => a.startOffset - b.startOffset || Number(a.overlap) - Number(b.overlap)),
    })),
  });
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

/** Deterministic SSML break for a line's reserved pause; empty when none. */
export const pauseBreakTag = (pauseMs: number): string => (pauseMs > 0 ? `<break time="${(pauseMs / 1000).toFixed(3)}s"/>` : "");

/**
 * The single canonical TTS text, derived from the approved lines. Each line's
 * reserved `pauseMs` becomes an explicit break tag, so the voiceover stage cannot
 * invent a second divergent copy of the script or silently drop a visual dwell.
 */
export const canonicalNarrationText = (script: Pick<ApprovedScript, "narration">) =>
  script.narration.map((line) => `${line.text.trim()}${pauseBreakTag(line.pauseMs ?? 0)}`).join("\n\n");

/**
 * Gap 4 (promoted) — claim-local evidence window.
 *
 * Verification bias fix: the verifier previously received only the exact cited
 * segment, so a claim whose meaning depends on the sentence before or after it was
 * judged out of context. This projection adds ±`neighbors` ordinal neighbours from
 * the same source, marks each segment `cited: true|false`, and enforces a hard
 * character budget. It never truncates source text: cited segments are always
 * included whole, and a neighbour that does not fit is omitted (and counted)
 * rather than cut.
 */
export const DEFAULT_EVIDENCE_WINDOW_NEIGHBORS = 1;
export const DEFAULT_EVIDENCE_WINDOW_CHARS = 24_000;

export type WindowedSegment = SourceSegment & { cited: boolean };

export type EvidenceWindowProjection = {
  schemaVersion: "claim-local-evidence-windowed/v1";
  claims: FactPack["claims"];
  evidenceSegments: WindowedSegment[];
  manifest: {
    neighbors: number;
    citedSegments: number;
    neighborSegments: number;
    omittedNeighborSegments: number;
    totalChars: number;
    budgetChars: number;
  };
};

export const withEvidenceWindow = (
  factPack: FactPack,
  map: SourceEvidenceMap,
  options: { neighbors?: number; maxWindowChars?: number } = {},
): EvidenceWindowProjection => {
  const neighbors = options.neighbors ?? DEFAULT_EVIDENCE_WINDOW_NEIGHBORS;
  const maxWindowChars = options.maxWindowChars ?? DEFAULT_EVIDENCE_WINDOW_CHARS;
  if (neighbors < 0) throw new Error("Evidence window neighbours must be non-negative");

  const sourcesById = new Map(map.sources.map((source) => [source.sourceId, source]));

  const citedIds = new Set<string>();
  for (const claim of factPack.claims) for (const segmentId of claim.evidence.segmentIds) citedIds.add(segmentId);

  const neighborIds = new Set<string>();
  for (const claim of factPack.claims) {
    const source = sourcesById.get(claim.evidence.sourceId);
    if (!source) throw new Error(`Evidence source ${claim.evidence.sourceId} is not in the locked source map`);
    const ordered = [...source.segments].sort((a, b) => a.ordinal - b.ordinal);
    for (const segmentId of claim.evidence.segmentIds) {
      const index = ordered.findIndex((segment) => segment.id === segmentId);
      if (index < 0) throw new Error(`Evidence segment ${segmentId} is not in the locked source map`);
      for (let offset = -neighbors; offset <= neighbors; offset += 1) {
        if (offset === 0) continue;
        const candidate = ordered[index + offset];
        if (candidate && !citedIds.has(candidate.id)) neighborIds.add(candidate.id);
      }
    }
  }

  const evidenceSegments: WindowedSegment[] = [];
  let omittedNeighborSegments = 0;
  let totalChars = 0;
  for (const source of map.sources) {
    for (const segment of [...source.segments].sort((a, b) => a.ordinal - b.ordinal)) {
      const cited = citedIds.has(segment.id);
      const isNeighbor = neighborIds.has(segment.id);
      if (!cited && !isNeighbor) continue;
      if (cited || totalChars + segment.text.length <= maxWindowChars) {
        evidenceSegments.push({ ...segment, cited });
        totalChars += segment.text.length;
      } else {
        omittedNeighborSegments += 1;
      }
    }
  }

  return {
    schemaVersion: "claim-local-evidence-windowed/v1",
    claims: factPack.claims,
    evidenceSegments,
    manifest: {
      neighbors,
      citedSegments: evidenceSegments.filter((segment) => segment.cited).length,
      neighborSegments: evidenceSegments.filter((segment) => !segment.cited).length,
      omittedNeighborSegments,
      totalChars,
      budgetChars: maxWindowChars,
    },
  };
};

export const projectFactVerificationContext = (factPack: FactPack, map: SourceEvidenceMap, options?: { neighbors?: number; maxWindowChars?: number }): EvidenceWindowProjection =>
  withEvidenceWindow(factPack, map, options);

export const projectScriptContext = (factPack: Pick<FactPack, "claims" | "caveats">, blueprint: { scenes: Array<{ id: string; claimIds: string[] }> }) => {
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

export const contextManifest = (
  projection: string,
  inputs: Array<{ role: string; hash: string; chars: number; itemCount?: number }>,
  metadata: { citedSegments?: number; neighborSegments?: number; omittedNeighborSegments?: number } = {},
) => ({
  projection,
  inputs: inputs.map((input) => ({ ...input })),
  totalChars: inputs.reduce((sum, input) => sum + input.chars, 0),
  ...metadata,
});
