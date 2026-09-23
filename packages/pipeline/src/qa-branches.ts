import {
  renderDiagramSvg,
  validateDiagramLayout,
  validateDiagramModel,
  type DiagramPalette,
} from "./diagram-qa.ts";
import { validateCaptionLayout, validateLoudness, validatePronunciation, validateRenderIntegrity, validateVoiceAlignment, type MediaIssue } from "./media-qa.ts";
import {
  consolidatedReviewIssues,
  validateClientAssetRights,
  validateEngineeringContent,
} from "./domain-qa.ts";
import type {
  ApprovedScript,
  CaptionCue,
  ConsolidatedReview,
  DiagramModel,
  Domain,
  FactPack,
  ResolvedLayout,
  WordTiming,
} from "@upcraft/contracts";
import type { DiagramArea, DiagramCanvas, LoudnessProbe, MediaProbe } from "@upcraft/compositor";

/**
 * Tiered release QA from section 11 of `docs/video-generation-process.md`.
 *
 * Tier A is deterministic and costs zero tokens: schema, artifact-completeness,
 * caption reconstruction, spatial-solve verification, and render-integrity
 * probes. Tier B is exactly one consolidated model review on a separately
 * routed verifier; deep per-domain model QA branches are deferred until Tier B
 * findings show they are needed. Tier C (human approval) is unchanged.
 *
 * Every check is pure and dependency-injected so the regression suite can prove
 * its decisions without a live queue, database, or provider. A validator never
 * re-uses the generator's own verdict: the visual check recomputes diagram
 * geometry and vocabulary from locked evidence, and the audio/render check
 * re-probes the produced bytes instead of trusting the pre-render request.
 */
export type QaIssue = MediaIssue;
export type QaCheckResult = { checks: string[]; issues: QaIssue[] };

export const QA_TIERS = ["A", "B"] as const;
export type QaTierName = (typeof QA_TIERS)[number];
export type QaTierResult = { tier: QaTierName; checks: string[]; issues: QaIssue[] };

const domainPolicyIssues = (input: StructuralQaInput["domainPolicy"]): QaIssue[] => {
  if (!input) return [];
  return [
    ...validateEngineeringContent({ domain: input.domain, script: input.script, factPack: input.factPack, diagramLabels: input.diagramLabels }),
    ...validateClientAssetRights({ domain: input.domain, assets: input.assets }),
  ];
};

export type StructuralQaInput = {
  captions: { words: WordTiming[]; cues: Array<{ wordIndexes: number[] }> };
  previewPresent: boolean;
  /** Roles of required locked artifacts that are missing or unvalidated. */
  missingArtifacts: string[];
  sceneCount: number;
  scriptSceneCount: number;
  assetIds: string[];
  /** The first attached asset of each manifest scene, when one exists. */
  sceneAssetIds: Array<string | undefined>;
  domainPolicy?: {
    domain: Domain;
    script: ApprovedScript;
    factPack: Pick<FactPack, "claims" | "caveats">;
    blueprint: { objective: string; scenes: Array<{ id: string; purpose: string; visualBeat: string }> };
    diagramLabels: string[];
    assets: Array<{ role: string; provenance: Record<string, unknown> | null }>;
  };
};

/**
 * Deterministic schema, artifact-completeness, caption-index, scene-asset, and
 * domain-policy validation. No model is involved, so this check can never be
 * satisfied by the generator's own claim that its output is valid.
 */
export const structuralQa = (input: StructuralQaInput): QaCheckResult => {
  const issues: QaIssue[] = [];
  const { captions } = input;

  const badWords = captions.words.filter((word, index) => word.endMs <= word.startMs || (index > 0 && word.startMs < (captions.words[index - 1]?.endMs ?? 0)));
  if (badWords.length) issues.push({ rule: "caption-monotonicity", evidence: { count: badWords.length }, remediation: "Rebuild caption timings from the validated narration alignment." });
  if (!input.previewPresent) issues.push({ rule: "preview-render-present", evidence: {}, remediation: "Render the preview from the locked project manifest." });
  if (input.missingArtifacts.length) issues.push({ rule: "artifact-completeness", evidence: { missing: input.missingArtifacts }, remediation: "Restore the missing validated upstream artifact before release." });
  if (!captions.cues.length || captions.cues.some((cue) => cue.wordIndexes.some((index) => index >= captions.words.length))) {
    issues.push({ rule: "caption-index-integrity", evidence: {}, remediation: "Rebuild captions with indexes into the locked word alignment." });
  }
  const assetIds = new Set(input.assetIds);
  if (input.sceneCount !== input.scriptSceneCount || input.sceneAssetIds.some((assetId) => !assetId || !assetIds.has(assetId))) {
    issues.push({ rule: "scene-asset-completeness", evidence: { scenes: input.sceneCount, scriptScenes: input.scriptSceneCount, assets: input.assetIds.length }, remediation: "Produce and attach one validated selected asset for every narrated scene." });
  }
  issues.push(...domainPolicyIssues(input.domainPolicy));
  return { checks: ["schema", "artifact-completeness", "caption-monotonicity", "caption-index-integrity", "scene-asset-completeness", "preview-render-present", "domain-policy"], issues };
};

export type VisualQaInput = {
  canvas: DiagramCanvas;
  safeArea: { top: number; right: number; bottom: number; left: number };
  captions: CaptionCue[];
  words: WordTiming[];
  /** Locked fact-pack/script/blueprint corpus a diagram label must come from. */
  lockedTexts: string[];
  allowedClaimIds: Set<string>;
  diagramModels: DiagramModel[];
  palette: DiagramPalette;
  area: DiagramArea;
};

/**
 * Visual continuity, diagram semantics, safe-area, and caption-overlap checks,
 * recomputed from locked artifacts. Diagram geometry and label vocabulary are
 * re-derived by re-rendering the typed model, independent of the asset stage.
 */
export const visualQa = (input: VisualQaInput): QaCheckResult => {
  const issues: QaIssue[] = [
    ...validateCaptionLayout({ canvas: input.canvas, safeArea: input.safeArea, captions: input.captions, words: input.words }),
  ];
  for (const model of input.diagramModels) {
    issues.push(...validateDiagramModel({ model, lockedTexts: input.lockedTexts, allowedClaimIds: input.allowedClaimIds }).map((issue) => ({ ...issue, evidence: { sceneId: model.sceneId, ...issue.evidence } })));
    const { layout } = renderDiagramSvg(model, input.palette, input.canvas, input.area);
    issues.push(...validateDiagramLayout({ model, layout }).map((issue) => ({ ...issue, evidence: { sceneId: model.sceneId, ...issue.evidence } })));
  }
  return { checks: ["caption-layout", "diagram-label-vocabulary", "diagram-geometry", "diagram-contrast"], issues };
};

export type AudioRenderQaInput = {
  words: WordTiming[];
  narrationDurationMs: number;
  /** Integrated loudness/true peak re-measured from the stored narration bytes. */
  loudness: LoudnessProbe;
  pronunciation: { narrationText: string; curatedTerms: string[] };
  expected: { durationMs: number; width: number; height: number; fps: number; frames: number; codec: string };
  /** The preview file re-probed from its stored bytes, never the request. */
  preview: MediaProbe;
};

/**
 * Audio duration/alignment, measured loudness/clipping, curated-domain-term
 * pronunciation, and render integrity measured from the produced file.
 */
export const audioRenderQa = (input: AudioRenderQaInput): QaCheckResult => ({
  checks: ["voice-alignment", "voice-loudness", "voice-pronunciation", "render-integrity"],
  issues: [
    ...validateVoiceAlignment({ words: input.words, measuredDurationMs: input.narrationDurationMs }),
    ...validateLoudness({ probe: input.loudness }),
    ...validatePronunciation({ narrationText: input.pronunciation.narrationText, words: input.words, curatedTerms: input.pronunciation.curatedTerms }),
    ...validateRenderIntegrity({
      probe: input.preview,
      expectedDurationMs: input.expected.durationMs,
      expectedWidth: input.expected.width,
      expectedHeight: input.expected.height,
      expectedFps: input.expected.fps,
      expectedFrames: input.expected.frames,
      requiredVideoCodec: input.expected.codec,
    }),
  ],
});

export type SpatialQaInput = {
  canvas: DiagramCanvas;
  safeArea: { top: number; right: number; bottom: number; left: number };
  layouts: ResolvedLayout[];
};

const rectIntersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Verifies the persisted `resolved-layout/v1` independently of the solver run:
 * layers must stay inside the canvas, paint order must be unique, and no layer
 * may overlap the caption panel. The LLM supplies semantics, never pixels, so
 * this is the deterministic check on whatever the solver produced.
 */
export const spatialQa = (input: SpatialQaInput): QaCheckResult => {
  const issues: QaIssue[] = [];
  // Fallback for older layouts; new layouts carry the true per-scene caption zone
  // computed at s10, so this QA check and the solver assertion agree exactly.
  const staticCaptionPanel = {
    x: input.safeArea.left,
    y: input.canvas.height - input.safeArea.bottom,
    width: input.canvas.width - input.safeArea.left - input.safeArea.right,
    height: input.safeArea.bottom,
  };
  for (const layout of input.layouts) {
    const captionPanel = layout.captionZone ?? staticCaptionPanel;
    if (layout.canvas.width !== input.canvas.width || layout.canvas.height !== input.canvas.height) {
      issues.push({ rule: "spatial-canvas-mismatch", evidence: { sceneId: layout.sceneId, layoutCanvas: layout.canvas, canvas: input.canvas }, remediation: "Recompute the resolved layout against the locked manifest canvas." });
    }
    const seenZ = new Set<number>();
    for (const layer of layout.layers) {
      if (layer.bounds.x < 0 || layer.bounds.y < 0 || layer.bounds.x + layer.bounds.width > input.canvas.width || layer.bounds.y + layer.bounds.height > input.canvas.height) {
        issues.push({ rule: "spatial-layer-out-of-bounds", evidence: { sceneId: layout.sceneId, layerId: layer.id, bounds: layer.bounds, canvas: input.canvas }, remediation: "Re-solve the overlay so every layer stays inside the canvas." });
      }
      if (seenZ.has(layer.zIndex)) {
        issues.push({ rule: "spatial-z-index-duplicate", evidence: { sceneId: layout.sceneId, layerId: layer.id, zIndex: layer.zIndex }, remediation: "Re-solve the overlay so each layer has a unique paint order." });
      }
      seenZ.add(layer.zIndex);
      if (captionPanel.width > 0 && captionPanel.height > 0 && rectIntersects(layer.bounds, captionPanel)) {
        issues.push({ rule: "spatial-caption-overlap", evidence: { sceneId: layout.sceneId, layerId: layer.id, bounds: layer.bounds, captionPanel }, remediation: "Re-solve the overlay so diagram layers do not overlap the caption panel." });
      }
    }
  }
  return { checks: ["spatial-solve", "spatial-containment", "spatial-z-order", "spatial-caption-overlap"], issues };
};

/** Composes every Tier A deterministic check into one zero-token tier result. */
export const deterministicQa = (...checks: QaCheckResult[]): QaTierResult => ({
  tier: "A",
  checks: checks.flatMap((check) => check.checks),
  issues: checks.flatMap((check) => check.issues),
});

/** Reduces the single separately routed Tier B review; no self-validation. */
export const consolidatedReviewQa = (review: ConsolidatedReview): QaTierResult => ({
  tier: "B",
  issues: consolidatedReviewIssues(review),
  checks: ["consolidated-review"],
});

export type QaConvergence = {
  complete: boolean;
  missing: QaTierName[];
  issues: QaIssue[];
  checks: string[];
};

/**
 * Convergence rule: approval may only be scheduled once every declared tier has
 * reported, and any critical finding fails the run. A partially completed tier
 * can therefore never produce a passing `qa-report/v1`.
 */
export const convergeQaTiers = (results: QaTierResult[]): QaConvergence => {
  const reported = new Set(results.map((result) => result.tier));
  const missing = QA_TIERS.filter((tier) => !reported.has(tier));
  return {
    complete: missing.length === 0,
    missing: [...missing],
    issues: results.flatMap((result) => result.issues),
    checks: results.flatMap((result) => result.checks),
  };
};
