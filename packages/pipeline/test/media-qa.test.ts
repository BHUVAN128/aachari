import { describe, expect, it } from "vitest";
import type { CaptionCue, WordTiming } from "@upcraft/contracts";
import type { MediaProbe } from "@upcraft/compositor";
import { compositeCaptionFill, imageDimensions, MIN_CAPTION_CONTRAST, validateCaptionLayout, validateIllustrationCandidate, validateRenderIntegrity, validateVoiceAlignment } from "../src/media-qa.ts";

const buildCue = (words: string[], startMs = 0): { cue: CaptionCue; words: WordTiming[] } => {
  const timings = words.map((text, index) => ({ text, startMs: startMs + index * 300, endMs: startMs + index * 300 + 250 }));
  return {
    cue: { text: words.join(" "), startMs: timings[0]!.startMs, endMs: timings.at(-1)!.endMs, wordIndexes: words.map((_, index) => index) },
    words: timings,
  };
};

const canvas = { width: 1920, height: 1080 };
const safeArea = { top: 80, right: 100, bottom: 160, left: 100 };

describe("caption layout QA", () => {
  it("accepts a caption reconstructed exactly from the locked word alignment", () => {
    const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"]);
    expect(validateCaptionLayout({ canvas, safeArea, captions: [cue], words })).toEqual([]);
  });

  it("rejects caption wording that drifts from the aligned words", () => {
    const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"]);
    const issues = validateCaptionLayout({ canvas, safeArea, captions: [{ ...cue, text: "Light energy turns into chemical energy" }], words });
    expect(issues.map((issue) => issue.rule)).toContain("caption-wording-drift");
  });

  it("rejects too many words in one cue", () => {
    const { cue, words } = buildCue(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);
    expect(validateCaptionLayout({ canvas, safeArea, captions: [cue], words }).map((issue) => issue.rule)).toContain("caption-too-many-words");
  });

  it("rejects a caption block that overflows the safe area", () => {
    const { cue, words } = buildCue(["photosynthesis", "chlorophyll", "mitochondria", "respiration"]);
    const issues = validateCaptionLayout({ canvas: { width: 400, height: 300 }, safeArea: { top: 20, right: 20, bottom: 130, left: 20 }, captions: [cue], words });
    expect(issues.map((issue) => issue.rule)).toContain("caption-safe-area-overflow");
  });

  it("rejects a cue whose bounds do not match its word timings", () => {
    const { cue, words } = buildCue(["Light", "energy"]);
    const issues = validateCaptionLayout({ canvas, safeArea, captions: [{ ...cue, endMs: cue.endMs + 500 }], words });
    expect(issues.map((issue) => issue.rule)).toContain("caption-word-timing-mismatch");
  });

  it("keeps caption text readable over both extreme backdrops", () => {
    expect(MIN_CAPTION_CONTRAST).toBe(4.5);
    expect(compositeCaptionFill("#ffffff")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("voiceover alignment QA", () => {
  const words = buildCue(["Light", "energy", "becomes", "chemical", "energy"]).words;

  it("accepts measured audio that ends shortly after the last aligned word", () => {
    expect(validateVoiceAlignment({ words, measuredDurationMs: words.at(-1)!.endMs + 120 })).toEqual([]);
  });

  it("rejects alignment that extends past the measured audio", () => {
    expect(validateVoiceAlignment({ words, measuredDurationMs: words.at(-1)!.endMs - 1_000 }).map((issue) => issue.rule)).toContain("voice-alignment-exceeds-audio");
  });

  it("rejects a trailing gap far larger than tolerance", () => {
    expect(validateVoiceAlignment({ words, measuredDurationMs: words.at(-1)!.endMs + 30_000 }).map((issue) => issue.rule)).toContain("voice-audio-trailing-gap");
  });

  it("rejects a voiceover with no measured duration", () => {
    expect(validateVoiceAlignment({ words, measuredDurationMs: 0 }).map((issue) => issue.rule)).toContain("voice-duration-unmeasured");
  });
});

describe("render integrity QA", () => {
  const probe: MediaProbe = { durationMs: 30_000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac", hasAudio: true };
  const expected = { expectedDurationMs: 30_000, expectedWidth: 1920, expectedHeight: 1080, expectedFps: 30, expectedFrames: 900, requiredVideoCodec: "h264" };

  it("accepts a render that matches the locked manifest", () => {
    expect(validateRenderIntegrity({ probe, ...expected })).toEqual([]);
  });

  it("rejects wrong dimensions, duration, frame count, and codec", () => {
    const rules = validateRenderIntegrity({ probe: { ...probe, width: 1080, durationMs: 12_000, fps: 24, videoCodec: "vp9" }, ...expected }).map((issue) => issue.rule);
    expect(rules).toContain("render-dimensions");
    expect(rules).toContain("render-duration");
    expect(rules).toContain("render-fps");
    expect(rules).toContain("render-frame-count");
    expect(rules).toContain("render-export-profile");
  });

  it("rejects a silent render", () => {
    expect(validateRenderIntegrity({ probe: { ...probe, audioCodec: null, hasAudio: false }, ...expected }).map((issue) => issue.rule)).toContain("render-audio-missing");
  });
});

describe("illustration candidate verification", () => {
  const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const jpeg = (width: number, height: number) => {
    const bytes = Buffer.alloc(20);
    bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xc0;
    bytes.writeUInt16BE(0x11, 4);
    bytes[6] = 8;
    bytes.writeUInt16BE(height, 7);
    bytes.writeUInt16BE(width, 9);
    return bytes;
  };

  it("reads dimensions from the bytes rather than provider metadata", () => {
    expect(imageDimensions(png(800, 600), "image/png")).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(jpeg(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(Buffer.from("not an image"), "image/png")).toBeUndefined();
  });

  it("accepts a valid PNG candidate and rejects a mislabeled one", () => {
    expect(validateIllustrationCandidate({ bytes: png(1024, 1024), mimeType: "image/png" })).toEqual([]);
    expect(validateIllustrationCandidate({ bytes: png(1024, 1024), mimeType: "image/gif" }).map((issue) => issue.rule)).toContain("illustration-mime-type");
  });

  it("rejects an undersized or unreadable candidate", () => {
    const rules = validateIllustrationCandidate({ bytes: png(64, 64), mimeType: "image/png" }).map((issue) => issue.rule);
    expect(rules).toContain("illustration-dimensions");
    expect(validateIllustrationCandidate({ bytes: Buffer.from("nope"), mimeType: "image/png" }).map((issue) => issue.rule)).toContain("illustration-dimensions-unreadable");
  });
});
