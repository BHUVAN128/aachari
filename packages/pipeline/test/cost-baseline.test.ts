import { describe, expect, it } from "vitest";
import { COST_BASELINE_MIN_SAMPLE, COST_REVIEW_MULTIPLIER, costReviewThreshold, durationBand, percentile75 } from "../src/runs.ts";

describe("accepted-video cost baseline", () => {
  it("bands comparable durations the way the cohort key expects", () => {
    expect(durationBand(15)).toBe("15-60");
    expect(durationBand(60)).toBe("15-60");
    expect(durationBand(61)).toBe("61-180");
    expect(durationBand(180)).toBe("61-180");
    expect(durationBand(181)).toBe("181-900");
  });

  it("computes a nearest-rank p75", () => {
    expect(percentile75([])).toBe(0);
    expect(percentile75([10])).toBe(10);
    expect(percentile75([1, 2, 3, 4])).toBe(3);
    expect(percentile75([4, 1, 3, 2])).toBe(3);
    expect(percentile75(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(15);
  });

  it("alerts only above 125% of the baseline p75", () => {
    const baseline = [100, 200, 300, 400];
    expect(COST_REVIEW_MULTIPLIER).toBe(1.25);
    expect(costReviewThreshold(baseline)).toBe(375);
    expect(COST_BASELINE_MIN_SAMPLE).toBe(20);
  });
});
