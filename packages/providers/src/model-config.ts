import {
  MODEL_CONFIG_VERSION,
  type ModelCapability,
  type ModelRoute,
  type ProviderId,
  type StageName,
} from "@upcraft/contracts";
import type { ProviderUsageSnapshot } from "./usage.ts";

/**
 * Single source of truth for model routing. This file implements the governing
 * rule in `docs/model-recommendations.md` §Routing: a concrete provider, model
 * identifier, capability configuration, fallback policy, and pricing version are
 * resolved before a stage starts and persisted on its stage checkpoint, so a
 * release record stays reproducible even when a provider default or environment
 * override later changes.
 *
 * Switching a stage's provider/model is one registry edit, or one environment
 * override written as a `provider/model` reference (for example
 * `GEMINI_VERIFIER_MODEL=openai/gpt-5.6-terra`).
 */

export const PRICING_VERSION = "pricing/2026-09-17";

const ELEVENLABS_CHARACTER_RATE_ENV = "ELEVENLABS_COST_MICRODOLLARS_PER_1K_CHARS";

type TokenPricing = { inputMicrounitsPerToken: number; outputMicrounitsPerToken: number };
type CharacterPricing = { per1kCharsEnv: string };
export type ModelPricing = TokenPricing | CharacterPricing | null;

export type ModelRouteSpec = {
  capability: ModelCapability;
  /** Default provider. A `provider/model` env override may replace it. */
  provider: ProviderId;
  envKey: string;
  defaultModel: string;
  credentialEnv: string[];
  transport: "native" | "gateway";
  pricing: ModelPricing;
  fallback?: { provider: ProviderId; model: string };
  policy?: Record<string, unknown>;
};

/**
 * The only place model identity lives. Defaults here must match the approved
 * table in `docs/model-recommendations.md` exactly.
 */
export const MODEL_ROUTES: Record<ModelCapability, ModelRouteSpec> = {
  "intake-brief": {
    capability: "intake-brief",
    provider: "ai-gateway",
    envKey: "INTAKE_BRIEF_MODEL",
    defaultModel: "openai/gpt-5.6-luna",
    credentialEnv: ["AI_GATEWAY_API_KEY"],
    transport: "gateway",
    pricing: null,
  },
  // Approved open-weight safety-classification job (docs/model-recommendations.md).
  // Runs before the billable briefing call; the same gateway credential gates it.
  "safety-classification": {
    capability: "safety-classification",
    provider: "ai-gateway",
    envKey: "INTAKE_SAFETY_MODEL",
    defaultModel: "openai/gpt-oss-safeguard-20b",
    credentialEnv: ["AI_GATEWAY_API_KEY"],
    transport: "gateway",
    pricing: null,
  },
  planning: {
    capability: "planning",
    provider: "openai",
    envKey: "OPENAI_PLANNING_MODEL",
    defaultModel: "gpt-5.6-terra",
    credentialEnv: ["OPENAI_API_KEY"],
    transport: "native",
    pricing: { inputMicrounitsPerToken: 2, outputMicrounitsPerToken: 12 },
    fallback: { provider: "openai", model: "gpt-5.6-sol" },
  },
  // Fact verification, script verification, and the single consolidated Tier B
  // review share the same approved second-provider route and env key today, but
  // remain distinct capabilities so their quality gates stay separate.
  "fact-verification": {
    capability: "fact-verification",
    provider: "gemini",
    envKey: "GEMINI_VERIFIER_MODEL",
    defaultModel: "gemini-3.8-flash",
    credentialEnv: ["GEMINI_API_KEY"],
    transport: "native",
    pricing: { inputMicrounitsPerToken: 0.75, outputMicrounitsPerToken: 3.75 },
    fallback: { provider: "openai", model: "gpt-5.6-terra" },
  },
  "script-verification": {
    capability: "script-verification",
    provider: "gemini",
    envKey: "GEMINI_VERIFIER_MODEL",
    defaultModel: "gemini-3.8-flash",
    credentialEnv: ["GEMINI_API_KEY"],
    transport: "native",
    pricing: { inputMicrounitsPerToken: 0.75, outputMicrounitsPerToken: 3.75 },
    fallback: { provider: "openai", model: "gpt-5.6-terra" },
  },
  "qa-review": {
    capability: "qa-review",
    provider: "gemini",
    envKey: "GEMINI_VERIFIER_MODEL",
    defaultModel: "gemini-3.8-flash",
    credentialEnv: ["GEMINI_API_KEY"],
    transport: "native",
    pricing: { inputMicrounitsPerToken: 0.75, outputMicrounitsPerToken: 3.75 },
    fallback: { provider: "openai", model: "gpt-5.6-terra" },
  },
  "research-web": {
    capability: "research-web",
    provider: "gemini",
    envKey: "GEMINI_RESEARCH_MODEL",
    defaultModel: "gemini-3.8-flash",
    credentialEnv: ["GEMINI_API_KEY"],
    transport: "native",
    pricing: { inputMicrounitsPerToken: 0.75, outputMicrounitsPerToken: 3.75 },
    fallback: { provider: "openai", model: "gpt-5.6-terra" },
  },
  illustration: {
    capability: "illustration",
    provider: "gemini",
    envKey: "GEMINI_IMAGE_MODEL",
    defaultModel: "gemini-3.1-flash-image",
    credentialEnv: ["GEMINI_API_KEY"],
    transport: "native",
    pricing: null,
    policy: { outputMime: "image/png" },
  },
  narration: {
    capability: "narration",
    provider: "elevenlabs",
    envKey: "ELEVENLABS_MODEL_ID",
    defaultModel: "eleven_multilingual_v2",
    credentialEnv: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
    transport: "native",
    pricing: { per1kCharsEnv: "ELEVENLABS_COST_MICRODOLLARS_PER_1K_CHARS" },
  },
};

/** The only place stage routing lives. `null` marks a deterministic stage. */
export const STAGE_CAPABILITIES: Record<StageName, ModelCapability | null> = {
  preflight: null,
  research: "planning",
  "fact-verification": "fact-verification",
  blueprint: "planning",
  script: "planning",
  "visual-bible": "planning",
  assets: "illustration",
  voiceover: "narration",
  captions: null,
  "spatial-layout": null,
  manifest: null,
  "preview-render": null,
  qa: "qa-review",
  approval: null,
  "final-render": null,
  "release-record": null,
};

const KNOWN_PROVIDERS: readonly ProviderId[] = ["openai", "gemini", "elevenlabs", "ai-gateway", "deterministic"];

const isProviderId = (value: string): value is ProviderId => (KNOWN_PROVIDERS as readonly string[]).includes(value);

const toModelRef = (provider: ProviderId, model: string) => {
  if (provider === "ai-gateway") return model;
  if (provider === "deterministic") return "deterministic/repository-code";
  return `${provider}/${model}`;
};

const freezeRoute = (route: ModelRoute): ModelRoute => Object.freeze(route);

/**
 * Parses an env override. A `provider/model` value reroutes the capability to a
 * concrete provider; a bare value keeps the default provider. A gateway route
 * always keeps provider `ai-gateway` because the value is an upstream ref.
 */
const parseOverride = (spec: ModelRouteSpec, raw: string): { provider: ProviderId; model: string } => {
  const value = raw.trim();
  if (spec.transport === "gateway") {
    if (!value) throw new Error(`${spec.envKey} must be a non-empty model reference`);
    return { provider: spec.provider, model: value };
  }
  const slash = value.indexOf("/");
  if (slash > 0) {
    const provider = value.slice(0, slash);
    if (!isProviderId(provider) || provider === "deterministic" || provider === "ai-gateway") throw new Error(`Unknown provider in ${spec.envKey}: ${provider}`);
    return { provider, model: value.slice(slash + 1) };
  }
  if (!value) throw new Error(`${spec.envKey} must be a non-empty model reference`);
  return { provider: spec.provider, model: value };
};

/** Resolves a frozen route for one capability; pure and env-injectable. */
export const resolveModelRoute = (capability: ModelCapability, env: NodeJS.ProcessEnv = process.env): ModelRoute => {
  const spec = MODEL_ROUTES[capability];
  const raw = env[spec.envKey];
  const resolvedFrom = raw?.trim() ? "env" : "default";
  const { provider, model } = raw?.trim() ? parseOverride(spec, raw) : { provider: spec.provider, model: spec.defaultModel };
  return freezeRoute({
    capability,
    provider,
    model,
    modelRef: toModelRef(provider, model),
    configVersion: MODEL_CONFIG_VERSION,
    resolvedFrom,
    pricingVersion: PRICING_VERSION,
  });
};

/**
 * Resolves the declared fallback for a capability. Execution lives in the
 * pipeline because usage and attempt recording do, but the route is declared
 * here so it is not an ad-hoc substitution.
 */
export const resolveFallbackRoute = (capability: ModelCapability, env: NodeJS.ProcessEnv = process.env): ModelRoute | undefined => {
  const spec = MODEL_ROUTES[capability];
  if (!spec.fallback) return undefined;
  const { provider, model } = spec.fallback;
  void env;
  return freezeRoute({
    capability,
    provider,
    model,
    modelRef: toModelRef(provider, model),
    configVersion: MODEL_CONFIG_VERSION,
    resolvedFrom: "fallback",
    pricingVersion: PRICING_VERSION,
  });
};

/** Credentials required before a capability may be scheduled. */
export const requiredCredentials = (capability: ModelCapability): string[] => [...MODEL_ROUTES[capability].credentialEnv];

const tokenRateFor = (provider: ProviderId): TokenPricing | undefined => {
  for (const spec of Object.values(MODEL_ROUTES)) {
    const pricing = spec.pricing;
    if (spec.provider === provider && pricing && "inputMicrounitsPerToken" in pricing) return pricing;
  }
  return undefined;
};

/**
 * Single copy of the pricing math. Cost is recorded against the provider that
 * actually served the attempt, including a fallback provider.
 */
export const estimateCostMicrounits = (provider: ProviderId | string, usage: ProviderUsageSnapshot, env: NodeJS.ProcessEnv = process.env): number | undefined => {
  if (provider === "elevenlabs") {
    const perThousandCharacters = Number(env[ELEVENLABS_CHARACTER_RATE_ENV]);
    if (!Number.isFinite(perThousandCharacters) || usage.inputCharacters === undefined) return undefined;
    return Math.ceil((usage.inputCharacters / 1_000) * perThousandCharacters);
  }
  if (!isProviderId(provider)) return undefined;
  const rate = tokenRateFor(provider);
  if (!rate || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  return Math.round((usage.inputTokens ?? 0) * rate.inputMicrounitsPerToken + (usage.outputTokens ?? 0) * rate.outputMicrounitsPerToken);
};
