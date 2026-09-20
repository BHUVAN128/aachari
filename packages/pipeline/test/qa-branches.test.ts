import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, BlueprintSchema, DiagramModelSchema, FactPackSchema, type DiagramModel } from "@upcraft/contracts";
import type { MediaProbe } from "@upcraft/compositor";
import type { DiagramPalette } from "@upcraft/compositor";
import {
  QA_BRANCHES,
  audioRenderQa,
  convergeQaBranches,
  pedagogyQa,
  structuralQa,
  visualQa,
  type QaBranchResult,
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
  schemaVersion: "lesson-blueprint/v1",
  objective: "Explain photosynthesis",
  prerequisites: [],
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

const probe: MediaProbe = { durationMs: 30_000, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac", hasAudio: true };
const expected = { durationMs: 30_000, width: 1920, height: 1080, fps: 30, frames: 900, codec: "h264" };

describe("structural QA branch", () => {
  const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);

  it("accepts a complete run and always reports every structural check", () => {
    const result = structuralQa({ captions: { words, cues: [cue] }, previewPresent: true, missingArtifacts: [], sceneCount: 1, scriptSceneCount: 1, assetIds: ["asset-1"], sceneAssetIds: ["asset-1"] });
    expect(result.branch).toBe("structural");
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

  it("applies the domain policy gates inside the structural branch", () => {
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

describe("visual QA branch", () => {
  const { cue, words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);
  const area = sceneDiagramArea(canvas);

  it("re-renders and re-validates a locked diagram independently of the asset stage", () => {
    const result = visualQa({
      canvas, safeArea, captions: [cue], words, lockedTexts, allowedClaimIds: new Set([claimId]),
      diagramModels: [diagramModel(["light energy", "chemical energy"])], palette, area,
    });
    expect(result.branch).toBe("visual");
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

describe("audio and render QA branch", () => {
  const { words } = buildCue(["Light", "energy", "becomes", "chemical", "energy"], 100);

  it("accepts aligned narration and a preview that matches the locked manifest", () => {
    const result = audioRenderQa({ words, narrationDurationMs: words.at(-1)!.endMs + 120, preview: probe, expected });
    expect(result.branch).toBe("audio-render");
    expect(result.issues).toEqual([]);
  });

  it("flags alignment past the measured audio and a render that does not match the manifest", () => {
    const rules = audioRenderQa({ words, narrationDurationMs: words.at(-1)!.endMs - 1_000, preview: { ...probe, width: 1080, videoCodec: "vp9" }, expected }).issues.map((issue) => issue.rule);
    expect(rules).toContain("voice-alignment-exceeds-audio");
    expect(rules).toContain("render-dimensions");
    expect(rules).toContain("render-export-profile");
  });
});

describe("pedagogy QA branch", () => {
  it("reduces a separately routed review without ever rewriting the lesson", () => {
    const passing = pedagogyQa({ schemaVersion: "pedagogy-review/v1", objectiveCovered: true, oneIdeaPerBeat: true, readingLevelAppropriate: true, issues: [] });
    expect(passing.issues).toEqual([]);
    const failing = pedagogyQa({ schemaVersion: "pedagogy-review/v1", objectiveCovered: false, oneIdeaPerBeat: true, readingLevelAppropriate: false, issues: [{ severity: "critical", evidence: "unsupported", remediation: "revise" }] });
    expect(failing.issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining(["pedagogy-critical", "pedagogy-objective-not-covered", "pedagogy-reading-level"]));
  });
});

describe("QA branch convergence", () => {
  const { cue, words } = buildCue(["Light", "energy"], 0);
  const passing: QaBranchResult = { branch: "structural", issues: [], checks: ["schema"] };
  const pedagogy: QaBranchResult = { branch: "pedagogy", issues: [], checks: ["pedagogy-review"] };
  const visual: QaBranchResult = { branch: "visual", issues: [], checks: ["caption-layout"] };
  const audio: QaBranchResult = { branch: "audio-render", issues: [], checks: ["render-integrity"] };

  it("declares exactly the four governed branches", () => {
    expect([...QA_BRANCHES]).toEqual(["structural", "pedagogy", "visual", "audio-render"]);
  });

  it("is complete only when every branch has reported", () => {
    expect(convergeQaBranches([passing, pedagogy, visual, audio])).toMatchObject({ complete: true, missing: [], issues: [] });
    const partial = convergeQaBranches([passing, visual, audio]);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(["pedagogy"]);
  });

  it("surfaces a critical finding from any branch as a blocking issue", () => {
    const failing: QaBranchResult = { branch: "visual", issues: [{ rule: "diagram-label-not-in-locked-vocabulary", evidence: {}, remediation: "fix" }], checks: ["caption-layout"] };
    const convergence = convergeQaBranches([passing, pedagogy, failing, audio]);
    expect(convergence.complete).toBe(true);
    expect(convergence.issues.map((issue) => issue.rule)).toContain("diagram-label-not-in-locked-vocabulary");
  });

  it("does not report pass while a branch is still missing, even with no findings yet", () => {
    const convergence = convergeQaBranches([audio]);
    expect(convergence.complete).toBe(false);
    expect(convergence.missing).toEqual(expect.arrayContaining(["structural", "pedagogy", "visual"]));
  });
});
