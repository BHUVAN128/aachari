import { describe, expect, it } from "vitest";
import { IntakeBriefV1Schema, IntakeBriefV2Schema } from "@upcraft/contracts";
import { enforceIntakeBriefPolicy } from "../src/intake.ts";

const brief = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "intake-brief/v2",
  topic: "How photosynthesis works",
  learningLevel: "Grade 8",
  domain: "standard",
  audienceCategory: "school",
  durationSeconds: 60,
  language: "en",
  visualProfile: "Precise, calm educational motion graphics",
  aspectRatio: "16:9",
  requestedDestination: "local",
  ...overrides,
});

describe("Intake Briefing Agent policy fence", () => {
  it("preserves the selected language exactly", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: brief({ language: "en" }) })).toThrow(/selected language/i);
    expect(enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "ta", brief: brief({ language: "ta" }) }).language).toBe("ta");
  });

  it("accepts a full configuration extracted from free text", () => {
    const parsed = enforceIntakeBriefPolicy({
      requestText: "create me a 10 minutes video explaining photosynthesis in Grade 10, vertical",
      language: "en",
      brief: brief({ durationSeconds: 600, learningLevel: "Grade 10", aspectRatio: "9:16" }),
    });
    expect(parsed.durationSeconds).toBe(600);
    expect(parsed.learningLevel).toBe("Grade 10");
    expect(parsed.aspectRatio).toBe("9:16");
  });

  it("defaults aspect ratio and destination when the model omits them", () => {
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
    const parsed = enforceIntakeBriefPolicy({ requestText: "Explain medication side effects for a patient", language: "en", brief: brief() });
    expect(parsed.domain).toBe("standard");
  });

  it("continues to reject malformed structured output", () => {
    expect(() => enforceIntakeBriefPolicy({ requestText: "photosynthesis working", language: "en", brief: { topic: "missing required fields" } })).toThrow();
  });
});
