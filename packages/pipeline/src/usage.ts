import { getDb, providerUsage, qaFindings } from "@upcraft/db";
import { PRICING_VERSION, estimateCostMicrounits, type ProviderUsageSnapshot } from "@upcraft/providers";
import type { StageName } from "@upcraft/contracts";
import { assertTelemetrySafe } from "./telemetry.ts";

/**
 * Provider accounting. `benchmarkstofocus.md` requires every provider attempt to
 * be accounted for, so `recordUsage` exists in exactly one place. Pure extraction
 * from `stages.ts`; behavior is unchanged.
 */
export const recordUsage = async (runId: string, stage: StageName, provider: string, model: string, startedAt: number, usage: ProviderUsageSnapshot = {}, promptVersion = `${stage}/v2`, context = {}, outcome = "completed", errorCode?: string) => {
  await getDb().insert(providerUsage).values({
    runId, stage, provider, model: usage.model ?? model, requestId: usage.requestId,
    outcome, errorCode, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens,
    inputCharacters: usage.inputCharacters, outputCharacters: usage.outputCharacters,
    costMicrounits: estimateCostMicrounits(provider, usage), pricingVersion: PRICING_VERSION,
    promptVersion, contextManifest: assertTelemetrySafe(context), latencyMs: Date.now() - startedAt,
  });
};

/**
 * Persists a critical QA finding and fails the stage. Kept beside usage so all
 * failure/provenance writes stay in the same durable-record layer.
 */
export const failWithFindings = async (runId: string, scope: string, findings: Array<{ rule: string; evidence: Record<string, unknown>; remediation: string }>): Promise<never> => {
  await getDb().insert(qaFindings).values(findings.map((finding) => ({ runId, rule: finding.rule, severity: "critical" as const, evidence: finding.evidence, remediation: finding.remediation })));
  throw new Error(`${scope} failed: ${findings.map((finding) => finding.rule).join(", ")}`);
};