import { describe, expect, it } from "vitest";
import { DiagramModelSchema, type DiagramModel } from "@upcraft/contracts";
import { contrastRatio, estimatedTextWidth, parseHex, plateOverlaps, renderDiagramSvg, type DiagramPalette } from "../src/diagrams.ts";

const canvas = { width: 1920, height: 1080 };
const area = { x: 230, y: 302, width: 1459, height: 518 };
const palette: DiagramPalette = {
  canvasTexture: "#f1f5f9",
  palette: ["#1d4ed8", "#b45309", "#047857", "#7e22ce"],
  typography: { heading: "Arial", body: "Arial" },
};
const sceneId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";

const model = (overrides: Partial<DiagramModel> = {}): DiagramModel => DiagramModelSchema.parse({
  schemaVersion: "diagram-model/v1",
  sceneId,
  kind: "process",
  title: "How photosynthesis works",
  labels: ["light energy", "chemical energy", "glucose"],
  values: [],
  claimIds: [claimId],
  ...overrides,
});

describe("diagram color and text geometry", () => {
  it("computes WCAG contrast and rejects invalid hex", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#f8fafc", "#f8fafc")).toBeCloseTo(1, 2);
    expect(parseHex("#zzzzzz")).toBeUndefined();
    expect(parseHex("red")).toBeUndefined();
  });

  it("detects overlapping plate geometry", () => {
    expect(plateOverlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(plateOverlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it("measures label width so overflow can be detected", () => {
    expect(estimatedTextWidth("short", 40)).toBeLessThan(estimatedTextWidth("a much longer label", 40));
  });
});

describe("deterministic diagram rendering", () => {
  it("renders byte-identical SVG for the same typed model", () => {
    expect(renderDiagramSvg(model(), palette, canvas, area).svg).toBe(renderDiagramSvg(model(), palette, canvas, area).svg);
  });

  it("produces a semantically distinct diagram per kind instead of one placeholder shape", () => {
    const svgs = new Set([
      renderDiagramSvg(model({ kind: "process", labels: ["a step", "another step"] }), palette, canvas, area).svg,
      renderDiagramSvg(model({ kind: "comparison", labels: ["first option", "second option", "detail"] }), palette, canvas, area).svg,
      renderDiagramSvg(model({ kind: "chart", labels: ["light", "chemical"], values: [10, 25] }), palette, canvas, area).svg,
      renderDiagramSvg(model({ kind: "labelled-system", labels: ["leaf", "vein", "stoma"] }), palette, canvas, area).svg,
      renderDiagramSvg(model({ kind: "none", labels: [] }), palette, canvas, area).svg,
    ]);
    expect(svgs.size).toBe(5);
    expect([...svgs].every((svg) => svg.startsWith("<svg xmlns="))).toBe(true);
  });

  it("draws process steps with connectors and measured anchors inside the canvas", () => {
    const { layout, svg } = renderDiagramSvg(model(), palette, canvas, area);
    expect(layout.plates.map((plate) => plate.id)).toEqual(["step-0", "step-1", "step-2"]);
    expect(layout.edges).toHaveLength(2);
    expect(svg).toContain("polyline");
    for (const anchor of layout.anchors) {
      expect(anchor.x).toBeGreaterThanOrEqual(0);
      expect(anchor.x).toBeLessThanOrEqual(1);
      expect(anchor.y).toBeGreaterThanOrEqual(0);
      expect(anchor.y).toBeLessThanOrEqual(1);
    }
    expect(layout.anchors.map((anchor) => anchor.name)).toContain("step-1:center");
    expect(layout.anchors.map((anchor) => anchor.name)).toContain("step-2:left");
  });
describe("diagram layout invariants", () => {
  it("never overlaps plates in any supported kind", () => {
    const cases: DiagramModel[] = [
      model({ kind: "process", labels: ["one", "two", "three", "four", "five", "six"] }),
      model({ kind: "comparison", labels: ["left head", "right head", "detail one", "detail two"] }),
      model({ kind: "equation", labels: ["mass", "acceleration"], expression: "force = mass * acceleration" }),
      model({ kind: "chart", labels: ["alpha", "beta", "gamma"], values: [1, 2, 3] }),
      model({ kind: "labelled-system", labels: ["cell", "nucleus", "membrane", "cytoplasm"] }),
      model({ kind: "none", labels: [] }),
    ];
    for (const candidate of cases) {
      const { layout } = renderDiagramSvg(candidate, palette, canvas, area);
      for (let left = 0; left < layout.plates.length; left += 1) {
        for (let right = left + 1; right < layout.plates.length; right += 1) {
          const a = layout.plates[left]!;
          const b = layout.plates[right]!;
          expect(plateOverlaps(a.bounds, b.bounds), `${candidate.kind} ${a.id} vs ${b.id}`).toBe(false);
        }
      }
    }
  });

  it("keeps every plate label legible against its own plate fill", () => {
    for (const kind of ["process", "comparison", "equation", "chart", "labelled-system", "none"] as const) {
      const { layout } = renderDiagramSvg(model({ kind, labels: ["first label", "second label"], values: [1, 5], expression: kind === "equation" ? "energy = mass" : undefined }), palette, canvas, area);
      for (const plate of layout.plates) expect(contrastRatio(plate.textColor, plate.fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("shrinks a long label to fit without editing its text", () => {
    const longLabel = "a long locked clause that must still be rendered in full";
    const { layout, svg } = renderDiagramSvg(model({ kind: "none", labels: [longLabel], title: longLabel }), palette, canvas, area);
    const plate = layout.plates[0]!;
    expect(plate.fontSize).toBeLessThan(40);
    expect(plate.label).toBe(longLabel);
    expect(svg).toContain("must still be rendered in full");
  });

  it("renders chart bars proportionally from the locked numeric values", () => {
    const { layout, svg } = renderDiagramSvg(model({ kind: "chart", labels: ["light", "chemical"], values: [10, 25] }), palette, canvas, area);
    expect(layout.plates).toHaveLength(2);
    expect(layout.plates[0]!.bounds.height).toBeLessThan(layout.plates[1]!.bounds.height);
    expect(svg).toContain("light: 10");
    expect(svg).toContain("chemical: 25");
  });

  it("escapes markup instead of injecting it into the SVG", () => {
    const { svg } = renderDiagramSvg(model({ kind: "none", labels: [], title: "a <script>alert(1)</script> label" }), palette, canvas, area);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
});