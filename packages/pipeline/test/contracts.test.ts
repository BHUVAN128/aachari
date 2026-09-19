import { describe, expect, it } from "vitest";
import { CaptionCueSchema, ProjectManifestSchema } from "@upcraft/contracts";

describe("video generation contracts", () => {
  it("keeps caption cues tied to valid word indexes", () => {
    expect(CaptionCueSchema.parse({ text: "A lesson", startMs: 0, endMs: 500, wordIndexes: [0, 1] })).toMatchObject({ wordIndexes: [0, 1] });
    expect(() => CaptionCueSchema.parse({ text: "A lesson", startMs: 500, endMs: 0, wordIndexes: [0] })).toThrow();
  });

  it("requires a complete, typed scene manifest", () => {
    const manifest = ProjectManifestSchema.parse({
      schemaVersion: "video-manifest/v1",
      fps: 30,
      canvas: { width: 1920, height: 1080 },
      safeArea: { top: 80, right: 100, bottom: 160, left: 100 },
      narrationAssetId: "11111111-1111-4111-8111-111111111111",
      words: [{ text: "Lesson", startMs: 0, endMs: 500 }],
      captions: [{ text: "Lesson", startMs: 0, endMs: 500, wordIndexes: [0] }],
      scenes: [{
        sceneId: "22222222-2222-4222-8222-222222222222",
        layoutArtifactId: "33333333-3333-4333-8333-333333333333",
        startMs: 0,
        endMs: 500,
        title: "Opening",
        visualBeat: "Reveal the concept",
        layers: [{
          id: "diagram",
          kind: "diagram",
          assetId: "44444444-4444-4444-8444-444444444444",
          assetUrl: "https://storage.example/asset.svg",
          zIndex: 1,
          bounds: { x: 100, y: 100, width: 1720, height: 700 },
        }],
      }],
    });
    expect(manifest.scenes[0]?.layers[0]?.assetUrl).toBe("https://storage.example/asset.svg");
  });
});
