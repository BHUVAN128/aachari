import { describe, expect, it } from "vitest";
import { DiagramModelSchema, type DiagramModel } from "@upcraft/contracts";
import { renderDiagramSvg, type DiagramPalette } from "@upcraft/compositor";
import { MIN_LABEL_CONTRAST, renderAndValidateDiagram, validateDiagramLayout, validateDiagramModel } from "../src/diagram-qa.ts";

const sceneId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const canvas = { width: 1920, height: 1080 };
const area = { x: 230, y: 302, width: 1459, height: 518 };
const palette: DiagramPalette = { canvasTexture: "#f1f5f9", palette: ["#1d4ed8", "#b45309"], typography: { heading: "Arial", body: "Arial" } };
const lockedTexts = ["Light energy becomes chemical energy in the leaf", "Light energy becomes chemical energy in the leaf."];
const allowedClaimIds = new Set([claimId]);

const model = (overrides: Partial<DiagramModel> = {}): DiagramModel => DiagramModelSchema.parse({
  schemaVersion: "diagram-model/v1",
  sceneId,
  kind: "process",
  title: "Light energy becomes chemical energy",
  labels: ["Light energy", "chemical energy"],
  values: [],
  claimIds: [claimId],
  ...overrides,
});

describe("diagram model QA against locked text", () => {
  it("accepts a diagram whose labels come from the locked corpus", () => {
    expect(validateDiagramModel({ model: model(), lockedTexts, allowedClaimIds })).toEqual([]);
  });

  it("rejects an invented label that never appears in locked text", () => {
    const issues = validateDiagramModel({ model: model({ labels: ["Light energy", "Krebs cycle"] }), lockedTexts, allowedClaimIds });
    expect(issues.map((issue) => issue.rule)).toContain("diagram-label-not-in-locked-vocabulary");
    expect(issues[0]!.evidence).toMatchObject({ unknown: ["krebs", "cycle"] });
  });

  it("rejects an invented title", () => {
    expect(validateDiagramModel({ model: model({ title: "Mitochondrial electron transport" }), lockedTexts, allowedClaimIds }).map((issue) => issue.rule))
      .toContain("diagram-label-not-in-locked-vocabulary");
  });

  it("rejects an equation that is not verbatim locked text", () => {
    const issues = validateDiagramModel({ model: model({ kind: "equation", labels: ["Light energy"], expression: "E = mc^2" }), lockedTexts, allowedClaimIds });
    expect(issues.map((issue) => issue.rule)).toContain("diagram-expression-not-locked");
  });

  it("rejects a plotted value that is not in the locked source", () => {
    const issues = validateDiagramModel({ model: model({ kind: "chart", labels: ["light", "chemical"], values: [12, 99] }), lockedTexts, allowedClaimIds });
    expect(issues.map((issue) => issue.rule)).toContain("diagram-value-not-in-locked-source");
  });

  it("rejects a claim reference outside the verified fact pack", () => {
    const issues = validateDiagramModel({ model: model({ claimIds: ["33333333-3333-4333-8333-333333333333"] }), lockedTexts, allowedClaimIds });
    expect(issues.map((issue) => issue.rule)).toContain("diagram-claim-reference-invalid");
  });

  it("rejects an under-specified semantic diagram that should fall back to a concept board", () => {
    const issues = validateDiagramModel({ model: model({ kind: "process", labels: ["Light energy"] }), lockedTexts, allowedClaimIds });
    expect(issues.map((issue) => issue.rule)).toContain("diagram-under-specified");
  });
});

describe("diagram layout QA", () => {
  it("passes a rendered diagram with complete, legible, non-overlapping plates", () => {
    const candidate = model();
    const { layout } = renderDiagramSvg(candidate, palette, canvas, area);
    expect(validateDiagramLayout({ model: candidate, layout })).toEqual([]);
  });

  it("detects a missing plate identity", () => {
    const candidate = model();
    const { layout } = renderDiagramSvg(candidate, palette, canvas, area);
    const truncated = { ...layout, plates: layout.plates.slice(0, 1) };
    expect(validateDiagramLayout({ model: candidate, layout: truncated }).map((issue) => issue.rule)).toContain("diagram-plate-missing");
  });

  it("detects overlapping geometry", () => {
    const candidate = model();
    const { layout } = renderDiagramSvg(candidate, palette, canvas, area);
    const first = layout.plates[0]!;
    const overlapped = { ...layout, plates: layout.plates.map((plate, index) => index === 1 ? { ...plate, bounds: { ...first.bounds } } : plate) };
    expect(validateDiagramLayout({ model: candidate, layout: overlapped }).map((issue) => issue.rule)).toContain("diagram-plate-overlap");
  });

  it("detects an illegible label/plate contrast", () => {
    const candidate = model();
    const { layout } = renderDiagramSvg(candidate, palette, canvas, area);
    const unreadable = { ...layout, plates: layout.plates.map((plate) => ({ ...plate, fill: plate.textColor })) };
    expect(validateDiagramLayout({ model: candidate, layout: unreadable }).map((issue) => issue.rule)).toContain("diagram-label-contrast");
  });

  it("uses an independent 4.5:1 threshold rather than trusting the renderer", () => {
    expect(MIN_LABEL_CONTRAST).toBe(4.5);
  });
});

describe("render and validate gate", () => {
  it("returns a passing diagram with real SVG and measured anchors", () => {
    const result = renderAndValidateDiagram({ model: model(), palette, canvas, area, lockedTexts, allowedClaimIds });
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.svg).toContain("<svg");
    expect(result.layout.anchors.length).toBeGreaterThan(0);
  });

  it("fails the gate instead of releasing a misleading diagram", () => {
    const result = renderAndValidateDiagram({ model: model({ labels: ["Light energy", "Krebs cycle"] }), palette, canvas, area, lockedTexts, allowedClaimIds });
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});