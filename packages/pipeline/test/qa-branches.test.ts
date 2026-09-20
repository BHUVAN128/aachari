import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, BlueprintSchema, ConsolidatedReviewSchema, DiagramModelSchema, FactPackSchema, ResolvedLayoutSchema, type DiagramModel } from "@upcraft/contracts";
import type { MediaProbe } from "@upcraft/compositor";
import type { DiagramPalette } from "@upcraft/compositor";
import {
  QA_TIERS,
  audioRenderQa,
  consolidatedReviewQa,
  convergeQaTiers,
  deterministicQa,
  spatialQa,
  structuralQa,
  visualQa,
  type QaTierResult,
} from "../src/qa-branches.ts";
import { sceneDiagramArea } from "../src/stages.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";
const claimId = "44444444-4444-4444-8444-444444444444";
const sourceHash = "a".repeat(64);
const canvas = { width: 1920, height: 1080 };
const safeArea = { top: 80, right: 100, bottom: 160, left: 100 };

const palette: DiagramPalette = { canvasTexture: "#f1f5f9", palette: ["#1d4ed8", "#b45309"], typography: { heading: "Arial", body: "Arial" } };

const buildCue = (words: string[], startMs = 0): { cue: { text: string; startMs: number; endMs: number; wordIndexes: number[] }; words: Array<{ text: string; startMs: number; endMs: number }> } => {
  const timings = words.map((text, index) => ({ text, startMs: startMs + index * 300, endMs: startMs + index * 300 + 250 }));
  return {
    cue: { text: words.join(" "), startMs: timings[0]!.startMs, endMs: timings.at(-1)!.endMs, wordIndexes: words.map((_, index) => index) },
    words: timings,
  };
};

const factPack = FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [{ id: claimId, text: "Light energy becomes chemical energy in the leaf", evidence: { sourceId, sourceHash, segmentIds: ["segment-one"], locator: "p1" }, critical: true }],
  caveats: [],
});
const blueprint = BlueprintSchema.parse({
  schemaVersion: "lesson-blueprint/v2",
  objective: "Explain photosynthesis",
  prerequisites: ["none required"],
  hook: "Why do leaves need light?",
  recap: "Light energy becomes chemical energy.",
  scenes: [{ id: sceneId, order: 0, purpose: "Show light energy becoming chemical energy", claimIds: [claimId], visualBeat: "Light energy becomes chemical energy" }],
});
const script = ApprovedScriptSchema.parse({
  schemaVersion: "approved-script/v2",
  narration: [{ id: lineId, sceneId, text: "Light energy becomes chemical energy in the leaf.", claimIds: [claimId], visualAction: "Reveal each step of the process" }],
});
const lockedTexts = [factPack.claims[0]!.text, `${script.narration[0]!.text} ${script.narration[0]!.visualAction}`, `${blueprint.scenes[0]!.purpose} ${blueprint.scenes[0]!.visualBeat}`];

const diagramModel = (labels: string[]): DiagramModel => DiagramModelSchema.parse({
  schemaVersion: "diagram-model/v1",
  sceneId,
  kind: "process",
  title: "Light energy",
  labels,
  values: [],
  claimIds: [claimId],
});

const layout = (overrides: Record<string, unknown> = {}) => ResolvedLayoutSchema.parse({
  schemaVersion: "resolved-layout/v1",
  sceneId,
  canvas,
  layers: [{ id: "diagram-" + sceneId, matrix: [1, 0, 0, 1, 0, 0], bounds: { x: 230, y: 302, width: 1459, height: 518 }, zIndex: 1 }],
  ...overrides,
});

const probe: MediaProbe = { durationMs: 30_000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac", hasAudio: true };
const expected = { durationMs: 30_000, width: 1920, height: 1080, fps: 30, frames: 900, codec: "h264" };

describe("Tier A structural check", () => {
  const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);

  it("accepts a complete run and always reports every structural check", () => {
    const result = structuralQa({ captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["asset-1"], sceneAssetIds: ["asset-1"] });
    expect(result.issues).toEqual([]);
    expect(result.checks).toContain("schema");
    expect(result.checks).toContain("domain-policy");
  });

  it("flags a missing preview, missing artifacts, and scene-asset gaps", () => {
    const rules = structuralQa({ captions: { words, cues: [cue] }, previewPresent: false, missingArtifacts: ["fact-pack"], sceneCount: 1, scriptSceneCount: 2, assetIds: [], sceneAssetIds: [undefined] }).issues.map((issue) => issue.rule);
    expect(rules).toContain("preview-render-present");
    expect(rules).toContain("artifact-completeness");
    expect(rules).toContain("scene-asset-completeness");
  });

  it("flags non-monotonic and out-of-range caption timing", () => {
    const broken = { words: [{ text: "a", startMs: 500, endMs: 400 }, ...words.slice(1)], cues: [{ ...cue, wordIndexes: [6] }] };
    const rules = structuralQa({ captions: broken, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["a"], sceneAssetIds: ["a"] }).issues.map((issue) => issue.rule);
    expect(rules).toContain("caption-monotonicity");
    expect(rules).toContain("caption-index-integrity");
  });

  it("applies the domain policy gates inside the structural check", () => {
    const engineering = structuralQa({
      captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["a"], sceneAssetIds: ["a"],
      domainPolicy: { domain: "engineering", script, factPack, blueprint, diagramLabels: [], sources: [], assets: [] },
    }).issues.map((issue) => issue.rule);
    expect(engineering).toContain("engineering-units-missing");

    const medical = structuralQa({
      captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["a"], sceneAssetIds: ["a"],
      domainPolicy: { domain: "medical", script, factPack, blueprint, diagramLabels: [], sources: [{ sourceUrl: "https://example.com/blog", retrievedAt: new Date() }], assets: [] },
    }).issues.map((issue) => issue.rule);
    expect(medical).toContain("medical-source-authority");

    const client = structuralQa({
      captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["a"], sceneAssetIds: ["a"],
      domainPolicy: { domain: "client-production", script, factPack, blueprint, diagramLabels: [], sources: [], assets: [{ role: "diagram-1", provenance: {} }] },
    }).issues.map((issue) => issue.rule);
    expect(client).toContain("client-rights-record-missing");
  });
});

describe("Tier A visual check", () => {
  const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);
  const area = sceneDiagramArea(canvas);

  it("re-renders and re-validates a locked diagram independently of the asset stage", () => {
    const result = visualQa({
      canvas, safeArea, captions: [cue], words, lockedTexts, allowedClaimIds: new Set([claimId]),
      diagramModels: [diagramModel(["light energy", "chemical energy"])], palette, area,
    });
    expect(result.issues).toEqual([]);
    expect(result.checks).toContain("caption-layout");
    expect(result.checks).toContain("diagram-geometry");
  });

  it("rejects a diagram label that is not in the locked vocabulary", () => {
    const rules = visualQa({
      canvas, safeArea, captions: [cue], words, lockedTexts, allowedClaimIds: new Set([claimId]),
      diagramModels: [diagramModel(["light energy", "quantum flux"])], palette, area,
    }).issues.map((issue) => issue.rule);
    expect(rules).toContain("diagram-label-not-in-locked-vocabulary");
  });

  it("recomputes caption layout from the locked word alignment", () => {
    const rules = visualQa({
      canvas, safeArea, captions: [{ ...cue, text: "Light energy turns into chemical energy" }], words, lockedTexts, allowedClaimIds: new Set([claimId]),
      diagramModels: [], palette, area,
    }).issues.map((issue) => issue.rule);
    expect(rules).toContain("caption-wording-drift");
  });
});

describe("Tier A spatial solve verification", () => {
  it("accepts a resolved layout that stays inside the canvas and clear of captions", () => {
    const result = spatialQa({ canvas, safeArea, layouts: [layout()] });
    expect(result.issues).toEqual([]);
    expect(result.checks).toContain("spatial-solve");
  });

  it("rejects an out-of-bounds layer, a duplicate paint order, and a caption overlap", () => {
    const bad = layout({
      layers: [
        { id: "a", matrix: [1, 0, 0, 1, 0, 0], bounds: { x: 1800, y: 100, width: 400, height: 400 }, zIndex: 1 },
        { id: "b", matrix: [1, 0, 0, 1, 0, 0], bounds: { x: 100, y: 100, width: 200, height: 200 }, zIndex: 1 },
        { id: "c", matrix: [1, 0, 0, 1, 0, 0], bounds: { x: 200, y: 950, width: 300, height: 100 }, zIndex: 2 },
      ],
    });
    const rules = spatialQa({ canvas, safeArea, layouts: [bad] }).issues.map((issue) => issue.rule);
    expect(rules).toContain("spatial-layer-out-of-bounds");
    expect(rules).toContain("spatial-z-index-duplicate");
    expect(rules).toContain("spatial-caption-overlap");
  });

  it("rejects a layout solved against a different canvas", () => {
    const rules = spatialQa({ canvas, safeArea, layouts: [layout({ canvas: { width: 1080, height: 1920 } })] }).issues.map((issue) => issue.rule);
    expect(rules).toContain("spatial-canvas-mismatch");
  });
});

describe("Tier A audio and render check", () => {
  const { words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);
  const loudness = { integratedLufs: -16, truePeakDb: -2 };
  const pronunciation = { narrationText: "Light energy becomes chemical energy", curatedTerms: [] as string[] };

  it("accepts aligned narration and a preview that matches the locked manifest", () => {
    const result = audioRenderQa({ words, narrationDurationMs: words.at(-1)!.endMs + 120, loudness, pronunciation, preview: probe, expected });
    expect(result.issues).toEqual([]);
    expect(result.checks).toContain("voice-loudness");
  });

  it("flags alignment past the measured audio and a render that does not match the manifest", () => {
    const rules = audioRenderQa({ words, narrationDurationMs: words.at(-1)!.endMs - 1_000, loudness, pronunciation, preview: { ...probe, width: 1080, videoCodec: "vp9" }, expected }).issues.map((issue) => issue.rule);
    expect(rules).toContain("voice-alignment-exceeds-audio");
    expect(rules).toContain("render-dimensions");
    expect(rules).toContain("render-export-profile");
  });

  it("flags out-of-range loudness, true-peak clipping, and a dropped curated term", () => {
    const rules = audioRenderQa({
      words, narrationDurationMs: words.at(-1)!.endMs + 120, preview: probe, expected,
      loudness: { integratedLufs: -5, truePeakDb: 0.4 },
      pronunciation: { narrationText: "Photosynthesis becomes chemical energy", curatedTerms: ["photosynthesis"] },
    }).issues.map((issue) => issue.rule);
    expect(rules).toContain("voice-loudness-out-of-range");
    expect(rules).toContain("voice-true-peak-clipping");
    expect(rules).toContain("voice-pronunciation-term-missing");
  });
});

describe("Tier B consolidated review", () => {
  it("reduces a separately routed review without ever rewriting the lesson", () => {
    const passing = consolidatedReviewQa(ConsolidatedReviewSchema.parse({ schemaVersion: "consolidated-review/v1", issues: [] }));
    expect(passing.tier).toBe("B");
    expect(passing.issues).toEqual([]);
    const failing = consolidatedReviewQa(ConsolidatedReviewSchema.parse({ schemaVersion: "consolidated-review/v1", issues: [{ domain: "factual", severity: "critical", evidence: "unsupported", remediation: "revise" }] }));
    expect(failing.issues.map((issue) => issue.rule)).toEqual(["consolidated-factual-critical"]);
  });
});

describe("Tier A composition and convergence", () => {
  const { cue, words } = buildCue(["Light", "energy"], 0);
  const area = sceneDiagramArea(canvas);

  it("composes every deterministic check into one zero-token Tier A result", () => {
    const tierA = deterministicQa(
      structuralQa({ captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["a"], sceneAssetIds: ["a"] }),
      visualQa({ canvas, safeArea, captions: [cue], words, lockedTexts: [], allowedClaimIds: new Set(), diagramModels: [], palette, area }),
      audioRenderQa({ words, narrationDurationMs: words.at(-1)!.endMs + 120, loudness: { integratedLufs: -16, truePeakDb: -2 }, pronunciation: { narrationText: "Light energy", curatedTerms: [] }, preview: probe, expected }),
      spatialQa({ canvas, safeArea, layouts: [layout()] }),
    );
    expect(tierA.tier).toBe("A");
    expect(tierA.issues).toEqual([]);
    expect(tierA.checks).toEqual(expect.arrayContaining(["schema", "caption-layout", "render-integrity", "spatial-solve"]));
  });

  it("declares exactly the two governed tiers", () => {
    expect([...QA_TIERS]).toEqual(["A", "B"]);
  });

  it("is complete only when every tier has reported", () => {
    const passingA: QaTierResult = { tier: "A", issues: [], checks: ["schema"] };
    const passingB: QaTierResult = { tier: "B", issues: [], checks: ["consolidated-review"] };
    expect(convergeQaTiers([passingA, passingB])).toMatchObject({ complete: true, missing: [], issues: [] });
    const partial = convergeQaTiers([passingA]);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(["B"]);
  });

  it("surfaces a critical finding from either tier as a blocking issue", () => {
    const failing: QaTierResult = { tier: "B", issues: [{ rule: "consolidated-factual-critical", evidence: {}, remediation: "fix" }], checks: ["consolidated-review"] };
    const convergence = convergeQaTiers([{ tier: "A", issues: [], checks: [] }, failing]);
    expect(convergence.complete).toBe(true);
    expect(convergence.issues.map((issue) => issue.rule)).toContain("consolidated-factual-critical");
  });

  it("does not report pass while a tier is still missing, even with no findings yet", () => {
    const convergence = convergeQaTiers([{ tier: "A", issues: [], checks: [] }]);
    expect(convergence.complete).toBe(false);
    expect(convergence.missing).toEqual(["B"]);
  });
});
