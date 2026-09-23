/**
 * Gap 3 — semantic segmentation.
 *
 * Promoted to `packages/pipeline/src/context.ts` in Phase 6 (this change). This
 * module re-exports the production implementation so the s02 sandbox keeps its
 * deterministic boundary assertions against the shipped code, not a copy.
 */
export {
  SEGMENT_TARGET_SIZE,
  OVERLAP_CONTEXT_CHARS,
  buildSourceEvidenceMapWithOverlap,
  chooseBoundary,
  resolveSegments,
  segmentationManifest,
  type SemanticSegment,
} from "@upcraft/pipeline";
