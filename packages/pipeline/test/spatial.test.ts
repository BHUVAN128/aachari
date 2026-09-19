import { describe, expect, it } from "vitest";
import { assertAttachment, solveAttachment } from "../src/spatial.ts";

describe("solveAttachment", () => {
  it("locks an overlay anchor to its measured target anchor instead of guessing x/y", () => {
    const face = { id: "face", width: 1000, height: 1000, anchors: [{ name: "left-eye-center", point: { x: 0.32, y: 0.41 }, provider: "landmark" as const, confidence: 0.99 }] };
    const beam = { id: "beam", width: 250, height: 120, anchors: [{ name: "origin", point: { x: 0.05, y: 0.5 }, provider: "svg" as const }] };
    const constraint = { subjectId: "beam", subjectAnchor: "origin", targetId: "face", targetAnchor: "left-eye-center", scale: 1.6, zIndex: 3, relation: "attach" as const };
    const layer = solveAttachment({ width: 1920, height: 1080 }, beam, face, constraint);

    expect(layer.bounds).toMatchObject({ x: 300, y: 314, width: 400, height: 192 });
    expect(() => assertAttachment(beam, face, layer, constraint)).not.toThrow();
  });

  it("rejects an unmasked behind-mask overlay", () => {
    const target = { id: "target", width: 100, height: 100, anchors: [{ name: "point", point: { x: 0.5, y: 0.5 }, provider: "svg" as const }] };
    const subject = { id: "subject", width: 20, height: 20, anchors: [{ name: "point", point: { x: 0.5, y: 0.5 }, provider: "svg" as const }] };
    const layer = solveAttachment({ width: 100, height: 100 }, subject, target, { subjectId: "subject", subjectAnchor: "point", targetId: "target", targetAnchor: "point", scale: 1, zIndex: 1, relation: "behind-mask" });
    expect(() => assertAttachment(subject, target, layer, { subjectId: "subject", subjectAnchor: "point", targetId: "target", targetAnchor: "point", scale: 1, zIndex: 1, relation: "behind-mask" })).toThrow("clip path");
  });
});
