import { describe, expect, it } from "vitest";
import { IntakeBriefSchema, IntakeSessionInputSchema } from "@upcraft/contracts";

describe("chat intake contracts", () => {
  it("accepts a photosynthesis request with a user-provided source", () => {
    const input = IntakeSessionInputSchema.parse({
      schemaVersion: "intake-session-input/v1",
      requestText: "photosynthesis working",
      language: "en",
      source: { kind: "text", name: "Primary source", value: "Photosynthesis converts light energy into chemical energy." },
    });
    expect(input.requestText).toBe("photosynthesis working");
    expect(IntakeBriefSchema.parse({ schemaVersion: "intake-brief/v1", topic: "How photosynthesis works", learningLevel: "Grade 8", domain: "standard", audienceCategory: "school", durationSeconds: 60, language: "en", visualProfile: "Precise, calm educational motion graphics" }).durationSeconds).toBe(60);
  });

  it("does not allow a chat session without a source", () => {
    expect(() => IntakeSessionInputSchema.parse({ schemaVersion: "intake-session-input/v1", requestText: "photosynthesis working", language: "en" })).toThrow();
  });
});
