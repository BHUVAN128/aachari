import { estimateCostMicrounits, PRICING_VERSION, type ProviderUsageSnapshot } from "@upcraft/providers";
import type { ModelRoute } from "@upcraft/contracts";

/**
 * Intake hardening — intake usage/pricing stamping (Point 7a).
 *
 * `processIntakeSession` writes `costMicrounits: null, pricingVersion: null`
 * unconditionally, which fails the live benchmark gate "Usage and context
 * accounting: 100% of provider attempts accounted for" (pricing version, cost).
 *
 * The intake route is a gateway route with no registered per-token price, so the
 * cost may legitimately be unknown — but the pricing version must always be
 * stamped and "unknown" must be an explicit, recorded state rather than a bare
 * null. This helper reuses the single production pricing math
 * (`estimateCostMicrounits`) so a later price registration flows through with no
 * second implementation.
 */

export type IntakeAttemptRecord = {
  requestId: string | null;
  provider: ModelRoute["provider"];
  model: string;
  promptVersion: string;
  pricingVersion: string;
  costMicrounits: number | null;
  unpriced: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  inputCharacters: number | null;
  outputCharacters: number | null;
  latencyMs: number;
  outcome: "completed" | "failed";
  errorCode: string | null;
  contextManifest: Record<string, unknown>;
};

const orNull = (value: number | undefined): number | null => (value === undefined ? null : value);

/**
 * Builds the persisted intake attempt record. `pricingVersion` is always present;
 * `costMicrounits` is null only when the route is genuinely unpriced, and
 * `unpriced` records that fact explicitly.
 */
export const buildIntakeAttemptRecord = (params: {
  usage: ProviderUsageSnapshot;
  route: ModelRoute;
  promptVersion: string;
  latencyMs: number;
  outcome: "completed" | "failed";
  errorCode?: string | null;
  contextManifest?: Record<string, unknown>;
}): IntakeAttemptRecord => {
  const cost = estimateCostMicrounits(params.route.provider, params.usage);
  return {
    requestId: params.usage.requestId ?? null,
    provider: params.route.provider,
    model: params.usage.model ?? params.route.model,
    promptVersion: params.promptVersion,
    pricingVersion: params.route.pricingVersion ?? PRICING_VERSION,
    costMicrounits: cost ?? null,
    unpriced: cost === undefined,
    inputTokens: orNull(params.usage.inputTokens),
    cachedInputTokens: orNull(params.usage.cachedInputTokens),
    outputTokens: orNull(params.usage.outputTokens),
    reasoningTokens: orNull(params.usage.reasoningTokens),
    inputCharacters: orNull(params.usage.inputCharacters),
    outputCharacters: orNull(params.usage.outputCharacters),
    latencyMs: params.latencyMs,
    outcome: params.outcome,
    errorCode: params.errorCode ?? null,
    contextManifest: params.contextManifest ?? {},
  };
};
