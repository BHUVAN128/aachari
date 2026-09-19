import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { MAX_ARTIFACT_ATTEMPTS, decideInvalidArtifactRetry, isArtifactValidationFailure } from "../src/stages.ts";
import { TelemetryLeakageError, assertTelemetrySafe } from "../src/telemetry.ts";
import { contextManifest } from "../src/context.ts";

const zodFailure = () => new ZodError([]);

describe("pipeline reliability policy", () => {
  it("bounds invalid-artifact regeneration", () => {
    expect(MAX_ARTIFACT_ATTEMPTS).toBe(3);
    expect(isArtifactValidationFailure(new SyntaxError("malformed JSON"))).toBe(true);
    expect(isArtifactValidationFailure(new Error("provider authentication failed"))).toBe(false);
  });

  it("regenerates a schema-invalid artifact with the validation error inside the budget", () => {
    expect(decideInvalidArtifactRetry({ attemptCount: 1, error: zodFailure() })).toEqual({
      regenerate: true,
      nextAttempt: 2,
      reason: "regenerate_with_validation_error",
    });
    expect(decideInvalidArtifactRetry({ attemptCount: 1, error: new SyntaxError("truncated JSON") }).regenerate).toBe(true);
  });

  it("stops regenerating at the attempt budget instead of looping", () => {
    expect(decideInvalidArtifactRetry({ attemptCount: MAX_ARTIFACT_ATTEMPTS, error: zodFailure() })).toEqual({
      regenerate: false,
      reason: "attempt_budget_exhausted",
    });
  });

  it("never treats a provider or safety failure as an artifact regeneration", () => {
    expect(decideInvalidArtifactRetry({ attemptCount: 1, error: new Error("Provider authentication failed") })).toEqual({
      regenerate: false,
      reason: "not_an_artifact_validation_failure",
    });
    expect(decideInvalidArtifactRetry({ attemptCount: 1, error: new Error("Independent verification rejected claims: abc") })).toEqual({
      regenerate: false,
      reason: "not_an_artifact_validation_failure",
    });
  });

  it("does not classify provider failures as artifact validation", () => {
    expect(isArtifactValidationFailure({ name: "ZodError", message: "not an actual Zod error" })).toBe(false);
  });
});

describe("private telemetry leakage fence", () => {
  it("accepts the projection metadata the pipeline actually records", () => {
    const manifest = contextManifest("claim-local-evidence/v1", [{ role: "fact-pack", hash: "a".repeat(64), chars: 120, itemCount: 3 }]);
    expect(() => assertTelemetrySafe(manifest)).not.toThrow();
    expect(manifest.totalChars).toBe(120);
  });

  it("rejects a raw prompt, source text, narration, or secret at any depth", () => {
    expect(() => assertTelemetrySafe({ projection: "x", inputs: [{ prompt: "raw private prompt" }] })).toThrow(TelemetryLeakageError);
    expect(() => assertTelemetrySafe({ sourceText: "private source" })).toThrow(/private payload key/i);
    expect(() => assertTelemetrySafe({ stage: { narration: "private narration" } })).toThrow(TelemetryLeakageError);
    expect(() => assertTelemetrySafe({ apiKey: "sk-live" })).toThrow(TelemetryLeakageError);
  });

  it("names the offending path so the leak is actionable", () => {
    expect(() => assertTelemetrySafe({ inputs: [{ extractedText: "x" }] }, "providerUsage")).toThrow(/providerUsage\.inputs\[0\]\.extractedText/);
  });
});
