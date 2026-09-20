import { ZodError } from "zod";

export const MAX_ARTIFACT_ATTEMPTS = 3;
export const isArtifactValidationFailure = (error: unknown) => error instanceof ZodError || error instanceof SyntaxError;

/**
 * Bounded regeneration policy for invalid model artifacts. A validation failure
 * may be regenerated with the validation error appended, never promoted by
 * syntactic repair alone, and never beyond the attempt budget.
 */
export const decideInvalidArtifactRetry = (params: { attemptCount: number; error: unknown }) => {
  if (!isArtifactValidationFailure(params.error)) return { regenerate: false, reason: "not_an_artifact_validation_failure" } as const;
  if (params.attemptCount >= MAX_ARTIFACT_ATTEMPTS) return { regenerate: false, reason: "attempt_budget_exhausted" } as const;
  return { regenerate: true, nextAttempt: params.attemptCount + 1, reason: "regenerate_with_validation_error" } as const;
};