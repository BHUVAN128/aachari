import {
  renderDiagramSvg,
  validateDiagramLayout,
  validateDiagramModel,
  type DiagramPalette,
} from "./diagram-qa.ts";
import { validateCaptionLayout, validateRenderIntegrity, validateVoiceAlignment, type MediaIssue } from "./media-qa.ts";
import {
  pedagogyReviewIssues,
  validateClientAssetRights,
  validateEngineeringContent,
  validateMedicalSources,
} from "./domain-qa.ts";
import type {
  ApprovedScript,
  CaptionCue,
  DiagramModel,
  Domain,
  FactPack,
  PedagogyReview,
  WordTiming,
} from "@upcraft/contracts";
import type { DiagramArea, DiagramCanvas, MediaProbe } from "@upcraft/compositor";

/**
 * Independent QA branches from section 9 of `docs/video-generation-process.md`.
 *
 * The preview render and its locked manifest are the only inputs, so the
 * branches may run concurrently (required parallelism table). Each branch is
 * pure and dependency-injected so the regression suite can prove its decisions
 * without a live queue, database, or provider. A validator never re-uses the
 * generator's own verdict: the visual branch recomputes diagram geometry and
 * vocabulary from locked evidence, and the audio/render branch re-probes the
 * produced bytes instead of trusting the pre-render request.
 */
export type QaBranchName = "structural" | "pedagogy" | "visual" | "audio-render";
export const QA_BRANCHES: readonly QaBranchName[] = ["structural", "pedagogy", "visual", "audio-render"];

export type QaIssue = MediaIssue;
export type QaBranchResult = { branch: QaBranchName; issues: QaIssue[]; checks: string[] };

const domainPolicyIssues = (input: StructuralQaInput["domainPolicy"]): QaIssue[] => {
  if (!input) return [];
  return [
    ...validateEngineeringContent({ domain: input.domain, script: input.script, factPack: input.factPack, diagramLabels: input.diagramLabels }),
    ...validateMedicalSources({ domain: input.domain, sources: input.sources }),
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
    factPack: FactPack;
    blueprint: { objective: string; scenes: Array<{ id: string; purpose: string; visualBeat: string }> };
    diagramLabels: string[];
    sources: Array<{ sourceUrl: string | null; retrievedAt: Date | null }>;
    assets: Array<{ role: string; provenance: Record<string, unknown> | null }>;
  };
};

/**
 * Deterministic schema, artifact-completeness, caption-index, scene-asset, and
 * domain-policy validation. No model is involved, so this branch can never be
 * satisfied by the generator's own claim that its output is valid.
 */
export const structuralQa = (input: StructuralQaInput): QaBranchResult => {
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
  return { branch: "structural", issues, checks: ["schema", "artifact-completeness", "caption-monotonicity", "caption-index-integrity", "scene-asset-completeness", "preview-render-present", "domain-policy"] };
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
export const visualQa = (input: VisualQaInput): QaBranchResult => {
  const issues: QaIssue[] = [
    ...validateCaptionLayout({ canvas: input.canvas, safeArea: input.safeArea, captions: input.captions, words: input.words }),
  ];
  for (const model of input.diagramModels) {
    issues.push(...validateDiagramModel({ model, lockedTexts: input.lockedTexts, allowedClaimIds: input.allowedClaimIds }).map((issue) => ({ ...issue, evidence: { sceneId: model.sceneId, ...issue.evidence } })));
    const { layout } = renderDiagramSvg(model, input.palette, input.canvas, input.area);
    issues.push(...validateDiagramLayout({ model, layout }).map((issue) => ({ ...issue, evidence: { sceneId: model.sceneId, ...issue.evidence } })));
  }
  return { branch: "visual", issues, checks: ["caption-layout", "diagram-label-vocabulary", "diagram-geometry", "diagram-contrast"] };
};

export type AudioRenderQaInput = {
  words: WordTiming[];
  narrationDurationMs: number;
  expected: { durationMs: number; width: number; height: number; fps: number; frames: number; codec: string };
  /** The preview file re-probed from its stored bytes, never the request. */
  preview: MediaProbe;
};

/** Audio duration/alignment plus render-integrity measured from the produced file. */
export const audioRenderQa = (input: AudioRenderQaInput): QaBranchResult => ({
  branch: "audio-render",
  issues: [
    ...validateVoiceAlignment({ words: input.words, measuredDurationMs: input.narrationDurationMs }),
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
  checks: ["voice-alignment", "render-integrity"],
});

/** Reducer over the separately routed pedagogy review; no self-validation. */
export const pedagogyQa = (review: PedagogyReview): QaBranchResult => ({
  branch: "pedagogy",
  issues: pedagogyReviewIssues(review).map((issue) => ({ rule: issue.rule, evidence: issue.evidence, remediation: issue.remediation })),
  checks: ["pedagogy-review"],
});

export type QaConvergence = {
  complete: boolean;
  missing: QaBranchName[];
  issues: QaIssue[];
  checks: string[];
};

/**
 * Convergence rule: approval may only be scheduled once every declared branch
 * has reported, and any critical finding fails the run. A partially completed
 * fan-out can therefore never produce a passing `qa-report/v1`.
 */
export const convergeQaBranches = (results: QaBranchResult[]): QaConvergence => {
  const reported = new Set(results.map((result) => result.branch));
  const missing = QA_BRANCHES.filter((branch) => !reported.has(branch));
  return {
    complete: missing.length === 0,
    missing: [...missing],
    issues: results.flatMap((result) => result.issues),
    checks: results.flatMap((result) => result.checks),
  };
};
