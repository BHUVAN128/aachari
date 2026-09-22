import { describe, expect, it } from "vitest";
import { MODEL_CONFIG_VERSION, ModelRouteSchema } from "@upcraft/contracts";
import { MODEL_ROUTES, PRICING_VERSION, STAGE_CAPABILITIES, estimateCostMicrounits, requiredCredentials, resolveFallbackRoute, resolveModelRoute } from "../src/model-config.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("model route registry", () => {
  it("matches the approved defaults in docs/model-recommendations.md exactly", () => {
    expect(MODEL_ROUTES["intake-brief"].defaultModel).toBe("openai/gpt-5.6-luna");
    expect(MODEL_ROUTES["safety-classification"].defaultModel).toBe("openai/gpt-oss-safeguard-20b");
    expect(MODEL_ROUTES["safety-classification"].provider).toBe("ai-gateway");
    expect(MODEL_ROUTES.planning.defaultModel).toBe("gpt-5.6-terra");
    expect(MODEL_ROUTES["fact-verification"].defaultModel).toBe("gemini-3.8-flash");
    expect(MODEL_ROUTES.illustration.defaultModel).toBe("gemini-3.1-flash-image");
    expect(MODEL_ROUTES.narration.defaultModel).toBe("eleven_multilingual_v2");
    expect(MODEL_ROUTES.planning.provider).toBe("openai");
    expect(MODEL_ROUTES["fact-verification"].provider).toBe("gemini");
  });

  it("resolves a frozen, fully typed route from injected env only", () => {
    const route = resolveModelRoute("planning", EMPTY_ENV);
    expect(ModelRouteSchema.parse(route)).toMatchObject({
      capability: "planning",
      provider: "openai",
      model: "gpt-5.6-terra",
      modelRef: "openai/gpt-5.6-terra",
      configVersion: MODEL_CONFIG_VERSION,
      resolvedFrom: "default",
      pricingVersion: PRICING_VERSION,
    });
    expect(Object.isFrozen(route)).toBe(true);
  });

  it("parses a provider/model env override and records resolvedFrom: env", () => {
    const route = resolveModelRoute("fact-verification", { GEMINI_VERIFIER_MODEL: "openai/gpt-5.6-terra" });
    expect(route).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", modelRef: "openai/gpt-5.6-terra", resolvedFrom: "env" });
  });

  it("keeps the default provider for a bare model override and keeps gateway refs intact", () => {
    expect(resolveModelRoute("planning", { OPENAI_PLANNING_MODEL: "gpt-5.6-sol" })).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", resolvedFrom: "env" });
    const gateway = resolveModelRoute("intake-brief", { INTAKE_BRIEF_MODEL: "openai/gpt-5.6-luna" });
    expect(gateway).toMatchObject({ provider: "ai-gateway", model: "openai/gpt-5.6-luna", modelRef: "openai/gpt-5.6-luna" });
  });

  it("rejects an unknown provider instead of silently substituting a default", () => {
    expect(() => resolveModelRoute("planning", { OPENAI_PLANNING_MODEL: "anthropic/claude" })).toThrow(/unknown provider/i);
  });

  it("declares the approved fallback routes but only for the second-provider jobs", () => {
    expect(resolveFallbackRoute("fact-verification")).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", resolvedFrom: "fallback" });
    expect(resolveFallbackRoute("planning")).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
    expect(resolveFallbackRoute("illustration")).toBeUndefined();
  });

  it("derives required credentials from the same registry", () => {
    expect(requiredCredentials("planning")).toEqual(["OPENAI_API_KEY"]);
    expect(requiredCredentials("narration")).toEqual(["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]);
    expect(requiredCredentials("intake-brief")).toEqual(["AI_GATEWAY_API_KEY"]);
    expect(requiredCredentials("safety-classification")).toEqual(["AI_GATEWAY_API_KEY"]);
  });

  it("maps every stage to a capability or an explicit deterministic stage", () => {
    expect(Object.keys(STAGE_CAPABILITIES)).toHaveLength(16);
    expect(STAGE_CAPABILITIES.research).toBe("planning");
    expect(STAGE_CAPABILITIES.qa).toBe("qa-review");
    expect(STAGE_CAPABILITIES.assets).toBe("illustration");
    expect(STAGE_CAPABILITIES.voiceover).toBe("narration");
    expect(STAGE_CAPABILITIES.preflight).toBeNull();
    expect(STAGE_CAPABILITIES["final-render"]).toBeNull();
  });

  it("prices tokens at the approved rate and reads the TTS character rate from env", () => {
    expect(estimateCostMicrounits("openai", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(2_000_000 + 12_000_000);
    expect(estimateCostMicrounits("gemini", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(750_000);
    expect(estimateCostMicrounits("elevenlabs", { inputCharacters: 2_500 }, { ELEVENLABS_COST_MICRODOLLARS_PER_1K_CHARS: "100" })).toBe(250);
    expect(estimateCostMicrounits("elevenlabs", { inputCharacters: 2_500 }, {})).toBeUndefined();
  });
});