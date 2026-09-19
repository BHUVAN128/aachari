import { describe, expect, it } from "vitest";
import { enforceIntakeBriefPolicy } from "../src/intake.ts";

const brief = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "intake-brief/v1",
  topic: "How photosynthesis works",
  learningLevel: "Grade 8",
  domain: "standard",
  audienceCategory: "school",
  durationSeconds: 60,
  language: "en",
  visualProfile: "Precise, calm educational motion graphics",
  ...overrides,
});

describe("Intake Briefing Agent policy fence", () => {
  it("preserves the selected language exactly", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: brief({ language: "en" }) })).toThrow(/selected language/i);
    expect(enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: brief({ language: "ta" }) }).language).toBe("ta");
  });

  it("rejects a model attempt to downgrade a health-adjacent request", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "Explain medication side effects for a patient", language: "en", brief: brief() })).toThrow(/medical/i);
    expect(enforceIntakeBriefPolicy({ requestText: "Explain medication side effects for a patient", language: "en", brief: brief({ domain: "medical" }) }).domain).toBe("medical");
  });

  it("continues to reject malformed structured output", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "en", brief: { topic: "missing required fields" } })).toThrow();
  });
});
