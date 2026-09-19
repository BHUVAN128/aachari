import { describe, expect, it } from "vitest";
import { ViewerOutcomeInputSchema } from "@upcraft/contracts";
import { fromMillionths, toMillionths } from "../src/outcomes.ts";

describe("viewer outcome recording", () => {
  it("stores fractional metrics deterministically as millionths", () => {
    expect(toMillionths(0.42)).toBe(420_000);
    expect(toMillionths(87.5)).toBe(87_500_000);
    expect(fromMillionths(420_000)).toBeCloseTo(0.42, 6);
  });

  it("accepts retention, quiz, and teacher feedback with a defaulted detail record", () => {
    const parsed = ViewerOutcomeInputSchema.parse({ schemaVersion: "viewer-outcome/v1", kind: "retention", metric: "intro-retention", value: 0.78 });
    expect(parsed.detail).toEqual({});
    expect(parsed.unit).toBeUndefined();
  });

  it("rejects an unknown feedback kind or a non-finite value", () => {
    expect(() => ViewerOutcomeInputSchema.parse({ schemaVersion: "viewer-outcome/v1", kind: "invented", metric: "x", value: 1 })).toThrow();
    expect(() => ViewerOutcomeInputSchema.parse({ schemaVersion: "viewer-outcome/v1", kind: "quiz", metric: "score", value: Number.POSITIVE_INFINITY })).toThrow();
  });
});
