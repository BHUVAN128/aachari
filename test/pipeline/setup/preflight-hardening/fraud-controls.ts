import { createHash } from "node:crypto";
import { eq, ne } from "drizzle-orm";
import { getDb, sourceDocuments, videoRuns } from "@upcraft/db";
import type { InputSnapshot, ModelCapability, ModelRoute } from "@upcraft/contracts";
import { estimateCostMicrounits, PRICING_VERSION, resolveModelRoute } from "@upcraft/providers";

/**
 * s01 Preflight hardening — billing-fraud controls (risk R4).
 *
 * `benchmarkstofocus.md` requires a run to be auditable *and* to guarantee that
 * "duplicate delivery creates no second run." Once the snapshot is frozen the
 * system can compute a deterministic estimate of the maximum cost the run could
 * accrue, and it can assert that the frozen input identity maps to exactly one
 * run. Both are zero-token checks that make cost and idempotency transparent
 * before any provider is called.
 */

/** A conservative, documented ceiling model — deterministic, not a forecast. */
export const COST_MODEL = {
  narrationCharsPerSecond: 15,
  secondsPerScene: 30,
  sceneChars: 1_500,
  charsPerToken: 4,
  fixedInputChars: 2_000,
} as const;

type BudgetSource = "narration" | "scene" | "fixed";
type CapabilityBudget = { calls: number; input: BudgetSource; output: BudgetSource; fixedInputChars?: number; fixedOutputChars?: number };

/**
 * Per-capability upper bounds. Planning is called once per planning stage
 * (research, blueprint, script, visual-bible); the others once per run.
 */
export const CAPABILITY_BUDGET: Record<ModelCapability, CapabilityBudget> = {
  "intake-brief": { calls: 1, input: "fixed", output: "fixed", fixedInputChars: 2_000, fixedOutputChars: 2_000 },
  "safety-classification": { calls: 1, input: "fixed", output: "fixed", fixedInputChars: 2_000, fixedOutputChars: 400 },
  planning: { calls: 4, input: "scene", output: "narration" },
  "fact-verification": { calls: 1, input: "narration", output: "narration" },
  "script-verification": { calls: 1, input: "narration", output: "narration" },
  "qa-review": { calls: 1, input: "narration", output: "fixed", fixedOutputChars: 4_000 },
  "research-web": { calls: 1, input: "fixed", output: "fixed", fixedInputChars: 4_000, fixedOutputChars: 8_000 },
  illustration: { calls: 1, input: "fixed", output: "fixed", fixedInputChars: 2_000, fixedOutputChars: 2_000 },
  narration: { calls: 1, input: "narration", output: "fixed", fixedOutputChars: 0 },
};

/** Every capability that may accrue cost during a run, in stage order. */
export const RUN_CAPABILITIES: readonly ModelCapability[] = [
  "intake-brief",
  "safety-classification",
  "planning",
  "fact-verification",
  "script-verification",
  "qa-review",
  "research-web",
  "illustration",
  "narration",
];

export type RouteCostCeiling = {
  capability: ModelCapability;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  inputCharacters: number | null;
  costMicrounits: number | null;
  unpriced: boolean;
};

export type CostCeiling = {
  pricingVersion: string;
  durationSeconds: number;
  sourceCount: number;
  totalMicrounits: number | null;
  unpriced: boolean;
  routes: RouteCostCeiling[];
};

const charBudget = (source: BudgetSource, budget: CapabilityBudget, narrationChars: number, sceneChars: number): number => {
  if (source === "narration") return narrationChars;
  if (source === "scene") return sceneChars;
  return source === "fixed" ? (budget.fixedInputChars ?? COST_MODEL.fixedInputChars) : 0;
};

const outputCharBudget = (budget: CapabilityBudget, narrationChars: number, sceneChars: number): number => {
  if (budget.output === "narration") return narrationChars;
  if (budget.output === "scene") return sceneChars;
  return budget.fixedOutputChars ?? 0;
};

/**
 * Deterministic upper bound of the run's provider cost from the frozen snapshot
 * and the resolved routes. Unpriced routes (gateway routes and unregistered image
 * pricing) are recorded explicitly as `unpriced: true`, mirroring the intake
 * usage/pricing stamping, so an unknown cost is a recorded state and never a
 * silent zero.
 */
export const estimateRunCostCeiling = (
  snapshot: Pick<InputSnapshot, "durationSeconds">,
  options: { sourceCount?: number; routes?: readonly ModelRoute[] } = {},
): CostCeiling => {
  const sourceCount = options.sourceCount ?? 0;
  const capabilities = RUN_CAPABILITIES.filter((capability) => capability !== "research-web" || sourceCount === 0);
  const routes = options.routes ?? capabilities.map((capability) => resolveModelRoute(capability));

  const narrationChars = snapshot.durationSeconds * COST_MODEL.narrationCharsPerSecond;
  const sceneChars = Math.max(1, Math.ceil(snapshot.durationSeconds / COST_MODEL.secondsPerScene)) * COST_MODEL.sceneChars;

  const routeCosts: RouteCostCeiling[] = routes.map((route) => {
    const budget = CAPABILITY_BUDGET[route.capability];
    const calls = budget.calls;
    const inputChars = charBudget(budget.input, budget, narrationChars, sceneChars) * calls;
    const outputChars = outputCharBudget(budget, narrationChars, sceneChars) * calls;

    // Image routes have no registered token price; a token estimate would be a
    // fabricated number, so they are explicitly unpriced.
    if (route.capability === "illustration") {
      return { capability: route.capability, provider: route.provider, model: route.model, calls, inputTokens: null, outputTokens: null, inputCharacters: inputChars, costMicrounits: null, unpriced: true };
    }
    if (route.capability === "narration" && route.provider === "elevenlabs") {
      const cost = estimateCostMicrounits("elevenlabs", { inputCharacters: inputChars });
      return { capability: route.capability, provider: route.provider, model: route.model, calls, inputTokens: null, outputTokens: null, inputCharacters: inputChars, costMicrounits: cost ?? null, unpriced: cost === undefined };
    }

    const inputTokens = Math.ceil(inputChars / COST_MODEL.charsPerToken);
    const outputTokens = Math.ceil(outputChars / COST_MODEL.charsPerToken);
    const cost = estimateCostMicrounits(route.provider, { inputTokens, outputTokens });
    return { capability: route.capability, provider: route.provider, model: route.model, calls, inputTokens, outputTokens, inputCharacters: null, costMicrounits: cost ?? null, unpriced: cost === undefined };
  });

  const anyUnpriced = routeCosts.some((route) => route.unpriced);
  const totalMicrounits = anyUnpriced ? null : routeCosts.reduce((sum, route) => sum + (route.costMicrounits ?? 0), 0);
  return {
    pricingVersion: PRICING_VERSION,
    durationSeconds: snapshot.durationSeconds,
    sourceCount,
    totalMicrounits,
    unpriced: anyUnpriced,
    routes: routeCosts,
  };
};

/**
 * A stable identity for a frozen input, independent of the random per-run
 * `sourceIds`: same topic/configuration and same source content => same key. This
 * is what makes duplicate delivery detectable.
 */
export const runIdentityKey = (snapshot: Pick<InputSnapshot, "topic" | "learningLevel" | "audienceCategory" | "language" | "durationSeconds" | "aspectRatio" | "domain" | "visualProfile" | "requestedDestination">, sourceHashes: readonly string[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        topic: snapshot.topic,
        learningLevel: snapshot.learningLevel,
        audienceCategory: snapshot.audienceCategory,
        language: snapshot.language,
        durationSeconds: snapshot.durationSeconds,
        aspectRatio: snapshot.aspectRatio,
        domain: snapshot.domain,
        visualProfile: snapshot.visualProfile,
        requestedDestination: snapshot.requestedDestination,
        sourceHashes: [...sourceHashes].sort(),
      }),
    )
    .digest("hex");

export type RunIdentityAssertion = {
  identityKey: string;
  duplicateRunId: string | null;
  unique: boolean;
};

/**
 * Asserts that the run's frozen identity maps to exactly one non-failed run. A
 * second `createVideoRun` with the same input is detected here (the production
 * fix is to reject it before inserting); the run must not be scheduled a second
 * time or billed twice.
 */
export const assertRunIdentityUnique = async (runId: string): Promise<RunIdentityAssertion> => {
  const db = getDb();
  const run = await db.query.videoRuns.findFirst({ where: eq(videoRuns.id, runId) });
  if (!run) throw new Error(`Run not found: ${runId}`);
  const sources = await db.select({ sha256: sourceDocuments.sha256 }).from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  const identityKey = runIdentityKey(run.snapshot, sources.map((source) => source.sha256));

  const others = await db
    .select({ id: videoRuns.id, snapshot: videoRuns.snapshot, status: videoRuns.status })
    .from(videoRuns)
    .where(ne(videoRuns.id, runId));

  let duplicateRunId: string | null = null;
  for (const other of others) {
    if (other.status === "failed") continue;
    const otherSources = await db.select({ sha256: sourceDocuments.sha256 }).from(sourceDocuments).where(eq(sourceDocuments.runId, other.id));
    if (runIdentityKey(other.snapshot, otherSources.map((source) => source.sha256)) === identityKey) {
      duplicateRunId = other.id;
      break;
    }
  }

  return { identityKey, duplicateRunId, unique: duplicateRunId === null };
};
