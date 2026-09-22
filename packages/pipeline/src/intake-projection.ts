import { createHash } from "node:crypto";

/**
 * Bounded intake-context projection (Point 2, promoted).
 *
 * `IntakeSessionInputSchema.requestText` may be up to 20,000 characters. Full
 * source material belongs to M2 research, not the lightweight M1 briefing call,
 * so the projection bounds the prompt and records exactly what was sent — never
 * a silent truncation — per the process document's projection-metadata rule.
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

/** The `contextManifest` record attached to an intake attempt. */
export const intakeContextManifest = (projection: IntakeContextProjection) => ({
  projection: projection.projectionVersion,
  hash: createHash("sha256").update(projection.projection).digest("hex"),
  chars: projection.projectedChars,
  itemCount: 1,
  originalChars: projection.originalChars,
  truncated: projection.truncated,
});
