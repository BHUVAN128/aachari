import type { ModelCapability, ModelRoute } from "@upcraft/contracts";
import { resolveModelRoute } from "./model-config.ts";
import { generateStructuredText, generateJsonText } from "./openai.ts";
import { searchGroundedText, verifyClaims } from "./gemini.ts";
import type { ProviderResult } from "./usage.ts";

/**
 * Thin capability dispatcher. It resolves the route and selects the adapter for
 * the provider prefix. Retry and fallback policy intentionally live in the
 * pipeline so every attempt is recorded against the same attempt budget.
 */

export const generateForCapability = async <T>(
  capability: ModelCapability,
  params: { prompt: string; schemaName: string; jsonSchema: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderResult<T>> => {
  const route = resolveModelRoute(capability, env);
  return generateStructuredText<T>(route, params);
};

/** Independent verification/review transport; provider is chosen from the route. */
export const reviewForCapability = async (
  capability: ModelCapability,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderResult<Record<string, unknown>>> => {
  const route = resolveModelRoute(capability, env);
  return reviewWithRoute(route, prompt);
};

/** Review transport for an explicit route, including a declared fallback route. */
export const reviewWithRoute = async (route: ModelRoute, prompt: string): Promise<ProviderResult<Record<string, unknown>>> => {
  if (route.provider === "gemini" || route.provider === "ai-gateway") return verifyClaims(route, prompt);
  if (route.provider === "openai") return generateJsonText(route, prompt);
  throw new Error(`No verifier transport for provider ${route.provider}`);
};

/** Web-grounded research transport; provider is chosen from the route. */
export const researchForCapability = async (
  capability: ModelCapability,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderResult<Record<string, unknown>>> => {
  const route = resolveModelRoute(capability, env);
  return researchWithRoute(route, prompt);
};

/** Web-grounded research transport for an explicit route, including fallback. */
export const researchWithRoute = async (route: ModelRoute, prompt: string): Promise<ProviderResult<Record<string, unknown>>> => {
  if (route.provider === "gemini") return searchGroundedText(route, prompt);
  if (route.provider === "openai") return generateJsonText(route, prompt);
  throw new Error(`No web-research transport for provider ${route.provider}`);
};
