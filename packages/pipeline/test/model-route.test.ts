import { describe, expect, it } from "vitest";
import { MODEL_CONFIG_VERSION, STAGE_ORDER, StageNameSchema } from "@upcraft/contracts";
import { MODEL_ROUTES, STAGE_CAPABILITIES } from "@upcraft/providers";
import { resolveStageRoute } from "../src/stages.ts";

describe("stage model routing", () => {
  it("is exhaustive over every governed stage name", () => {
    expect(Object.keys(STAGE_CAPABILITIES).sort()).toEqual([...StageNameSchema.options].sort());
    expect(Object.keys(STAGE_CAPABILITIES)).toHaveLength(STAGE_ORDER.length);
  });

  it("only maps to a declared capability", () => {
    for (const capability of Object.values(STAGE_CAPABILITIES)) {
      if (capability !== null) expect(Object.keys(MODEL_ROUTES)).toContain(capability);
    }
  });

  it("treats deterministic stages as no route so provenance stays deterministic", () => {
    for (const stage of STAGE_ORDER) {
      const route = resolveStageRoute(stage);
      if (STAGE_CAPABILITIES[stage] === null) expect(route).toBeUndefined();
      else expect(route?.configVersion).toBe(MODEL_CONFIG_VERSION);
    }
  });

  it("routes planning, verification, illustration, and narration to their approved providers", () => {
    expect(resolveStageRoute("research")).toMatchObject({ capability: "planning", provider: "openai" });
    expect(resolveStageRoute("blueprint")).toMatchObject({ capability: "planning" });
    expect(resolveStageRoute("script")).toMatchObject({ capability: "planning" });
    expect(resolveStageRoute("visual-bible")).toMatchObject({ capability: "planning" });
    expect(resolveStageRoute("fact-verification")).toMatchObject({ capability: "fact-verification", provider: "gemini" });
    expect(resolveStageRoute("qa")).toMatchObject({ capability: "qa-review", provider: "gemini" });
    expect(resolveStageRoute("assets")).toMatchObject({ capability: "illustration", provider: "gemini" });
    expect(resolveStageRoute("voiceover")).toMatchObject({ capability: "narration", provider: "elevenlabs" });
  });

  it("separates the script generator from the independent script verifier", () => {
    const generator = resolveStageRoute("script");
    const verifier = resolveStageRoute("fact-verification");
    expect(generator?.provider).not.toBe(verifier?.provider);
    expect(generator?.capability).toBe("planning");
  });
});