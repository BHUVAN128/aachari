import { describe, expect, it } from "vitest";
import { buildSrt, srtTimestamp } from "../src/render-exports.ts";

describe("SRT transcript derivation", () => {
  it("formats SRT timestamps with millisecond precision", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(1_234)).toBe("00:00:01,234");
    expect(srtTimestamp(3_661_005)).toBe("01:01:01,005");
    expect(srtTimestamp(-50)).toBe("00:00:00,000");
  });

  it("derives numbered cues directly from the locked caption text", () => {
    const srt = buildSrt([
      { text: "Light energy", startMs: 0, endMs: 1_000 },
      { text: "becomes chemical energy", startMs: 1_100, endMs: 2_500 },
    ]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,000\nLight energy\n\n2\n00:00:01,100 --> 00:00:02,500\nbecomes chemical energy\n");
  });

  it("emits nothing when there are no captions", () => {
    expect(buildSrt([])).toBe("");
  });
});
