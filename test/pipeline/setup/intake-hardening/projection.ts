import { createHash } from "node:crypto";

/**
 * Intake hardening — bounded intake-context projection (Point 2).
 *
 * `IntakeSessionInputSchema.requestText` may be up to 20,000 characters. When a
 * user pastes a large source block without the `Source:` delimiter, that raw
 * source text flows into the lightweight M1 briefing call unpriced and
 * unrecorded. Full source material belongs to M2 (the research stage), not M1.
 *
 * This projection bounds the M1 call and, per the process document's projection
 * rule ("Projection metadata records artifact hashes, segment IDs, item counts,
 * and character counts"), records exactly what was sent — never a silent
 * truncation. The projection version is carried into the attempt's
 * `contextManifest` so a release record can prove what the model saw.
 */

export const DEFAULT_INTAKE_CONTEXT_CHARS = 2_000;
export const INTAKE_CONTEXT_PROJECTION_VERSION = "intake-context/v1";

export type IntakeContextProjection = {
  projection: string;
  truncated: boolean;
  originalChars: number;
  projectedChars: number;
  projectionVersion: string;
};

/**
 * Returns the prefix of `requestText` bounded to `maxChars`, recording the
 * original and projected lengths plus whether any text was dropped.
 */
export const projectIntakeContext = (requestText: string, options: { maxChars?: number } = {}): IntakeContextProjection => {
  const maxChars = options.maxChars ?? DEFAULT_INTAKE_CONTEXT_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error(`maxChars must be a positive integer, received ${maxChars}`);
  const truncated = requestText.length > maxChars;
  const projection = truncated ? requestText.slice(0, maxChars) : requestText;
  return {
    projection,
    truncated,
    originalChars: requestText.length,
    projectedChars: projection.length,
    projectionVersion: INTAKE_CONTEXT_PROJECTION_VERSION,
  };
};

/** The `contextManifest` record attached to the intake attempt (logger shape). */
export const intakeContextManifest = (projection: IntakeContextProjection) => ({
  projection: projection.projectionVersion,
  hash: createHash("sha256").update(projection.projection).digest("hex"),
  chars: projection.projectedChars,
  itemCount: 1,
  originalChars: projection.originalChars,
  truncated: projection.truncated,
});
