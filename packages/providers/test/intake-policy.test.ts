import { describe, expect, it } from "vitest";
import { IntakeBriefV1Schema, IntakeBriefV2Schema } from "@upcraft/contracts";
import { enforceIntakeBriefPolicy } from "../src/intake.ts";

const extraction = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "intake-brief/v3",
  topic: "How photosynthesis works",
  language: "en",
  domain: "standard",
  learningLevel: "Grade 8",
  audienceCategory: "school",
  durationSeconds: 60,
  visualProfile: "Precise, calm educational motion graphics",
  aspectRatio: "16:9",
  requestedDestination: "local",
  computedComplexity: 2,
  durationProvided: true,
  ...overrides,
});

describe("Intake Briefing Agent policy fence", () => {
  it("preserves the selected language exactly", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: extraction({ language: "en" }) })).toThrow(/selected language/i);
    expect(enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: extraction({ language: "ta" }) }).language).toBe("ta");
  });

  it("accepts a full configuration extracted from free text", () => {
    const parsed = enforceIntakeBriefPolicy({
      requestText: "create me a 10 minutes video explaining photosynthesis in Grade 10, vertical",
      language: "en",
      brief: extraction({ durationSeconds: 600, learningLevel: "Grade 10", aspectRatio: "9:16" }),
    });
    expect(parsed.durationSeconds).toBe(600);
    expect(parsed.learningLevel).toBe("Grade 10");
    expect(parsed.aspectRatio).toBe("9:16");
  });

  it("allows omitted configuration to be null so code owns the defaults", () => {
    const parsed = enforceIntakeBriefPolicy({
      requestText: "photosynthesis working",
      language: "en",
      brief: extraction({ learningLevel: null, audienceCategory: null, durationSeconds: null, visualProfile: null, aspectRatio: null, requestedDestination: null, computedComplexity: null, durationProvided: false }),
    });
    expect(parsed.learningLevel).toBeNull();
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.durationProvided).toBe(false);
  });

  it("retains the v2 defaults for an already-complete frozen brief", () => {
    const parsed = IntakeBriefV2Schema.parse({
      schemaVersion: "intake-brief/v2",
      topic: "How photosynthesis works",
      learningLevel: "Grade 8",
      domain: "standard",
      audienceCategory: "school",
      durationSeconds: 60,
      language: "en",
      visualProfile: "Precise, calm educational motion graphics",
    });
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.requestedDestination).toBe("local");
  });

  it("continues to read a retained v1 brief", () => {
    expect(IntakeBriefV1Schema.parse({
      schemaVersion: "intake-brief/v1",
      topic: "How photosynthesis works",
      learningLevel: "Grade 8",
      domain: "standard",
      audienceCategory: "school",
      durationSeconds: 60,
      language: "en",
      visualProfile: "Precise, calm educational motion graphics",
    }).schemaVersion).toBe("intake-brief/v1");
  });

  it("does not treat a health-adjacent request as a special domain", () => {
    const parsed = enforceIntakeBriefPolicy({ requestText: "Explain medication side effects for a patient", language: "en", brief: extraction() });
    expect(parsed.domain).toBe("standard");
  });

  it("continues to reject malformed structured output", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "en", brief: { topic: "missing required fields" } })).toThrow();
  });
});
