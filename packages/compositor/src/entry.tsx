import React from "react";
import { AbsoluteFill, Audio, Composition, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionCue, ProjectManifest } from "@upcraft/contracts";

type LessonProps = { title: string; manifest: ProjectManifest; audioUrl: string };

const frameAt = (milliseconds: number, fps: number) => Math.floor((milliseconds / 1000) * fps);

const Caption: React.FC<{ cue: CaptionCue; words: ProjectManifest["words"]; sceneStartMs: number }> = ({ cue, words, sceneStartMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000 + sceneStartMs;
  const opacity = interpolate(currentMs, [cue.startMs, cue.startMs + 100, cue.endMs], [0, 1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ opacity, maxWidth: 1300, padding: "20px 34px", borderRadius: 18, backgroundColor: "rgba(15, 23, 42, .84)", textAlign: "center", fontSize: 58, lineHeight: 1.12, fontFamily: "Arial, sans-serif", fontWeight: 700, color: "#f8fafc" }}>
      {cue.wordIndexes.map((index, position) => {
        const word = words[index];
        if (!word) return null;
        const active = currentMs >= word.startMs && currentMs < word.endMs;
        return <React.Fragment key={String(word.startMs) + "-" + String(position)}>{position > 0 ? " " : null}<span style={{ color: active ? "#facc15" : "#f8fafc" }}>{word.text}</span></React.Fragment>;
      })}
    </div>
  );
};

const Scene: React.FC<{ scene: ProjectManifest["scenes"][number]; manifest: ProjectManifest; title: string }> = ({ scene, manifest, title }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const nowMs = ((frame / fps) * 1000) + scene.startMs;
  const cue = manifest.captions.find((candidate) => nowMs >= candidate.startMs && nowMs < candidate.endMs);
  return (
    <AbsoluteFill style={{ backgroundColor: "#f8fafc", color: "#0f172a", overflow: "hidden" }}>
      {scene.layers.filter((layer) => layer.kind === "background").map((layer) => <div key={layer.id} style={{ position: "absolute", inset: 0, backgroundColor: layer.color ?? "#f8fafc", zIndex: layer.zIndex }} />)}
      <div style={{ position: "absolute", top: 90, left: 100, right: 100, fontFamily: "Arial, sans-serif", fontSize: 64, fontWeight: 800, zIndex: 5 }}>{title}</div>
      <div style={{ position: "absolute", top: 190, left: 100, right: 100, fontFamily: "Arial, sans-serif", fontSize: 34, color: "#475569", zIndex: 5 }}>{scene.visualBeat}</div>
      {scene.layers.filter((layer) => layer.kind === "diagram" || layer.kind === "illustration").map((layer) => layer.assetUrl ? <Img key={layer.id} src={layer.assetUrl} style={{ position: "absolute", left: layer.bounds.x, top: layer.bounds.y, width: layer.bounds.width, height: layer.bounds.height, zIndex: layer.zIndex }} /> : <div key={layer.id} style={{ position: "absolute", left: layer.bounds.x, top: layer.bounds.y, width: layer.bounds.width, height: layer.bounds.height, zIndex: layer.zIndex, border: "4px solid #2563eb", borderRadius: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 36, textAlign: "center", fontFamily: "Arial, sans-serif", fontSize: 42 }}>{layer.text ?? scene.visualBeat}</div>)}
      {cue ? <div style={{ position: "absolute", left: manifest.safeArea.left, right: manifest.safeArea.right, bottom: manifest.safeArea.bottom, zIndex: 10 }}><Caption cue={cue} words={manifest.words} sceneStartMs={scene.startMs} /></div> : null}
    </AbsoluteFill>
  );
};

const Lesson: React.FC<LessonProps> = ({ title, manifest, audioUrl }) => (
  <AbsoluteFill style={{ backgroundColor: "#f8fafc" }}>
    {manifest.scenes.map((scene) => <Sequence key={scene.sceneId} from={frameAt(scene.startMs, manifest.fps)} durationInFrames={Math.max(1, frameAt(scene.endMs, manifest.fps) - frameAt(scene.startMs, manifest.fps))}><Scene scene={scene} manifest={manifest} title={title} /></Sequence>)}
    {audioUrl ? <Audio src={audioUrl} /> : null}
  </AbsoluteFill>
);

const defaultManifest: ProjectManifest = {
  schemaVersion: "video-manifest/v1",
  fps: 30,
  canvas: { width: 1920, height: 1080 },
  safeArea: { top: 80, right: 100, bottom: 160, left: 100 },
  narrationAssetId: "00000000-0000-0000-0000-000000000000",
  words: [],
  captions: [],
  scenes: [{
    sceneId: "11111111-1111-4111-8111-111111111111",
    layoutArtifactId: "00000000-0000-0000-0000-000000000000",
    startMs: 0,
    endMs: 1000,
    title: "Lesson",
    visualBeat: "Educational visual",
    layers: [{ id: "default-layer", kind: "diagram", zIndex: 1, bounds: { x: 240, y: 330, width: 1440, height: 500 }, text: "Educational visual" }],
  }],
};

export const RemotionRoot: React.FC = () => <Composition
  id="Lesson"
  component={Lesson}
  width={1920}
  height={1080}
  fps={30}
  durationInFrames={30}
  defaultProps={{ title: "Lesson", manifest: defaultManifest, audioUrl: "" }}
  calculateMetadata={({ props }) => ({ width: props.manifest.canvas.width, height: props.manifest.canvas.height, fps: props.manifest.fps, durationInFrames: Math.max(1, Math.ceil((props.manifest.scenes.at(-1)?.endMs ?? 1_000) / 1000 * props.manifest.fps)) })}
/>;
