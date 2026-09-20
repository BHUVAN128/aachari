import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getSilentParts, getVideoMetadata } from "@remotion/renderer";

/**
 * Measured properties of a rendered media file. Render integrity is judged from
 * the actual bytes on disk, never from the manifest that was requested, so a
 * dropped frame, silent track, or truncated render is visible.
 */
export type MediaProbe = {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
};

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/** Loudness and true-peak measured from the produced audio bytes. */
export type LoudnessProbe = {
  integratedLufs: number;
  truePeakDb: number;
};

/**
 * Resolves the ffmpeg binary bundled with the pinned Remotion renderer so
 * loudness measurement uses the exact renderer toolchain rather than relying on
 * a system install.
 */
export const ffmpegPath = (): string => {
  const packageJson = require.resolve("@remotion/renderer/package.json") as string;
  const { getExecutablePath } = require(join(dirname(packageJson), "dist/compositor/get-executable-path.js")) as {
    getExecutablePath: (options: { type: "ffmpeg" | "ffprobe"; indent: boolean; logLevel: string }) => string;
  };
  return getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error" });
};

const parseLoudnessSummary = (output: string): LoudnessProbe => {
  const integrated = /"input_i"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/.exec(output);
  const peak = /"input_tp"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/.exec(output);
  if (!integrated || !peak) throw new Error("ffmpeg loudnorm did not report integrated loudness and true peak");
  return { integratedLufs: Number(integrated[1]), truePeakDb: Number(peak[1]) };
};

/**
 * Measures EBU R128 integrated loudness (LUFS) and true peak (dBFS) of an audio
 * file with the renderer's bundled ffmpeg. The bundled build ships `loudnorm`
 * (not `ebur128`), which reports the same BS.1770 `input_i`/`input_tp` summary.
 * Release QA requires loudness and clipping to be measured from produced bytes,
 * never assumed from the request.
 */
export const probeLoudness = async (source: string): Promise<LoudnessProbe> => {
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), ["-hide_banner", "-nostats", "-i", source, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
    return parseLoudnessSummary(stderr);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === "string" && stderr.includes("input_i")) return parseLoudnessSummary(stderr);
    throw error;
  }
};

/** The concrete renderer version required to reproduce a render. */
export const rendererVersion = (): string => {
  const pkg = require("remotion/package.json") as { version?: string };
  return pkg.version ?? "unknown";
};

/** Frame count implied by the measured duration; not copied from the request. */
export const deriveFrameCount = (probe: Pick<MediaProbe, "durationMs" | "fps">) =>
  probe.fps > 0 ? Math.round((probe.durationMs / 1000) * probe.fps) : 0;

export const probeMedia = async (source: string): Promise<MediaProbe> => {
  const metadata = await getVideoMetadata(source, { logLevel: "error" });
  return {
    durationMs: Math.round((metadata.durationInSeconds ?? 0) * 1000),
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    videoCodec: metadata.codec,
    audioCodec: metadata.audioCodec,
    hasAudio: metadata.audioCodec !== null,
  };
};

/**
 * Measures an audio-only track (for example the narration MP3). The video
 * metadata probe requires a video stream, so audio duration is measured with
 * the renderer's silence analyzer instead.
 */
export const probeAudioDurationMs = async (source: string): Promise<number> => {
  const { durationInSeconds } = await getSilentParts({ src: source, logLevel: "error" });
  return Math.round(durationInSeconds * 1000);
};
