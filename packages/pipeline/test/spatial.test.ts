import { describe, expect, it } from "vitest";
import { assertAttachment, solveAttachment, solveSceneLayout } from "../src/spatial.ts";

const sceneId = "22222222-2222-4222-8222-222222222222";
const diagramAssetId = "33333333-3333-4333-8333-333333333333";
const illustrationAssetId = "44444444-4444-4444-8444-444444444444";

describe("solveAttachment", () => {
  it("locks an overlay anchor to its measured target anchor instead of guessing x/y", () => {
    const face = { id: "face", width: 1000, height: 1000, anchors: [{ name: "left-eye-center", point: { x: 0.32, y: 0.41 }, provider: "landmark" as const, confidence: 0.99 }] };
    const beam = { id: "beam", width: 250, height: 120, anchors: [{ name: "origin", point: { x: 0.05, y: 0.5 }, provider: "svg" as const }] };
    const constraint = { subjectId: "beam", subjectAnchor: "origin", targetId: "face", targetAnchor: "left-eye-center", scale: 1.6, zIndex: 3, relation: "attach" as const };
    const layer = solveAttachment({ width: 1920, height: 1080 }, beam, face, constraint);

    expect(layer.bounds).toMatchObject({ x: 300, y: 314, width: 400, height: 192 });
    expect(() => assertAttachment(beam, face, layer, constraint)).not.toThrow();
  });

  it("solves a multi-layer scene layout from measured anchors and asserts drift", () => {
    const layout = solveSceneLayout({
      sceneId,
      canvas: { width: 1920, height: 1080 },
      diagram: {
        assetId: diagramAssetId, width: 1920, height: 1080, bounds: { x: 230, y: 302, width: 1459, height: 518 }, zIndex: 1,
        anchors: [{ name: "concept:center", point: { x: 0.5, y: 0.5865 }, provider: "svg" }],
      },
      illustration: { assetId: illustrationAssetId, width: 1024, height: 1024, targetAnchor: "concept:center", zIndex: 0 },
    });
    expect(layout.layers.map((layer) => layer.id)).toEqual([`illustration-${sceneId}`, `diagram-${sceneId}`]);
    expect(layout.layers[0]!.assetId).toBe(illustrationAssetId);
    const overlay = layout.layers[0]!;
    expect(Math.abs(overlay.bounds.x + overlay.bounds.width / 2 - 0.5 * 1920)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(overlay.bounds.y + overlay.bounds.height / 2 - 0.5865 * 1080)).toBeLessThanOrEqual(0.75);
    expect(overlay.bounds.x).toBeGreaterThanOrEqual(0);
    expect(overlay.bounds.x + overlay.bounds.width).toBeLessThanOrEqual(1920);
  });

  it("never emits an illustration layer when the scene has none", () => {
    const layout = solveSceneLayout({
      sceneId,
      canvas: { width: 1920, height: 1080 },
      diagram: { assetId: diagramAssetId, width: 1920, height: 1080, bounds: { x: 230, y: 302, width: 1459, height: 518 }, anchors: [], zIndex: 1 },
    });
    expect(layout.layers.map((layer) => layer.id)).toEqual([`diagram-${sceneId}`]);
  });

  it("rejects an illustration attached to an anchor the diagram never measured", () => {
    expect(() => solveSceneLayout({
      sceneId,
      canvas: { width: 1920, height: 1080 },
      diagram: { assetId: diagramAssetId, width: 1920, height: 1080, bounds: { x: 230, y: 302, width: 1459, height: 518 }, anchors: [], zIndex: 1 },
      illustration: { assetId: illustrationAssetId, width: 1024, height: 1024, targetAnchor: "system:center", zIndex: 0 },
    })).toThrow("measured anchor");
  });

  it("rejects an unmasked behind-mask overlay", () => {
    const target = { id: "target", width: 100, height: 100, anchors: [{ name: "point", point: { x: 0.5, y: 0.5 }, provider: "svg" as const }] };
    const subject = { id: "subject", width: 20, height: 20, anchors: [{ name: "point", point: { x: 0.5, y: 0.5 }, provider: "svg" as const }] };
    const layer = solveAttachment({ width: 100, height: 100 }, subject, target, { subjectId: "subject", subjectAnchor: "point", targetId: "target", targetAnchor: "point", scale: 1, zIndex: 1, relation: "behind-mask" });
    expect(() => assertAttachment(subject, target, layer, { subjectId: "subject", subjectAnchor: "point", targetId: "target", targetAnchor: "point", scale: 1, zIndex: 1, relation: "behind-mask" })).toThrow("clip path");
  });
});
