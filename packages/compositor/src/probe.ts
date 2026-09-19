import { createRequire } from "node:module";
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
