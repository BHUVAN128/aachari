import type { FactPack, SourceEvidenceMap, SourceSegment } from "@upcraft/contracts";

/**
 * s03 sandbox — claim-local evidence window (test-local; promoted at Phase 6).
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
