import { describe, expect, it } from "vitest";
import { deriveFrameCount, rendererVersion } from "../src/probe.ts";

describe("media probe helpers", () => {
  it("derives frame count from measured duration and fps", () => {
    expect(deriveFrameCount({ durationMs: 30_000, fps: 30 })).toBe(900);
    expect(deriveFrameCount({ durationMs: 1_001, fps: 30 })).toBe(30);
  });

  it("never divides by an invalid frame rate", () => {
    expect(deriveFrameCount({ durationMs: 30_000, fps: 0 })).toBe(0);
  });

  it("reports a concrete renderer version for reproducible renders", () => {
    expect(rendererVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
