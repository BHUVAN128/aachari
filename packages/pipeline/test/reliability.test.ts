import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_ATTEMPTS, isArtifactValidationFailure } from "../src/stages.ts";

describe("pipeline reliability policy", () => {
  it("bounds invalid-artifact regeneration", () => {
    expect(MAX_ARTIFACT_ATTEMPTS).toBe(3);
    expect(isArtifactValidationFailure(new SyntaxError("malformed JSON"))).toBe(true);
    expect(isArtifactValidationFailure(new Error("provider authentication failed"))).toBe(false);
  });

  it("does not classify provider failures as artifact validation", () => {
    expect(isArtifactValidationFailure({ name: "ZodError", message: "not an actual Zod error" })).toBe(false);
  });
});
