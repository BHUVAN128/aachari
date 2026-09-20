import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { deriveFrameCount, ffmpegPath, probeLoudness, rendererVersion } from "../src/probe.ts";

const execFileAsync = promisify(execFile);

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

  it("resolves the pinned renderer ffmpeg binary", () => {
    expect(ffmpegPath()).toContain("ffmpeg");
  });

  it("measures integrated loudness and true peak from produced audio bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upcraft-loudness-"));
    try {
      const source = join(dir, "tone.wav");
      await execFileAsync(ffmpegPath(), ["-hide_banner", "-nostats", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-y", source]);
      const probe = await probeLoudness(source);
      expect(Number.isFinite(probe.integratedLufs)).toBe(true);
      expect(Number.isFinite(probe.truePeakDb)).toBe(true);
      expect(probe.integratedLufs).toBeLessThan(0);
      expect(probe.integratedLufs).toBeGreaterThan(-40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
