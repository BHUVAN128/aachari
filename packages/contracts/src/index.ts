import { z } from "zod";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "failed",
  "completed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const DomainSchema = z.enum([
  "standard",
  "engineering",
  "medical",
  "client-production",
]);
export type Domain = z.infer<typeof DomainSchema>;

export const AudienceCategorySchema = z.enum(["school", "college", "other"]);
export type AudienceCategory = z.infer<typeof AudienceCategorySchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const StageNameSchema = z.enum([
  "preflight",
  "research",
  "fact-verification",
  "blueprint",
  "script",
  "visual-bible",
  "assets",
  "voiceover",
  "captions",
  "spatial-layout",
  "manifest",
  "preview-render",
  "qa",
  "approval",
  "final-render",
  "release-record",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const ArtifactStatusSchema = z.enum([
  "pending",
  "valid",
  "invalid",
  "failed",
  "superseded",
]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const InputSnapshotSchema = z.object({
  schemaVersion: z.literal("input-snapshot/v1"),
  topic: z.string().min(3).max(500),
  learningLevel: z.string().min(2).max(120),
  audienceCategory: AudienceCategorySchema.default("school"),
  language: z.string().min(2).max(16).default("en"),
  durationSeconds: z.number().int().min(15).max(900),
  aspectRatio: AspectRatioSchema.default("16:9"),
  domain: DomainSchema,
  visualProfile: z.string().min(2).max(200),
  requestedDestination: z.string().min(1).max(200).default("local"),
  sourceIds: z.array(z.string().uuid()).default([]),
});
export type InputSnapshot = z.infer<typeof InputSnapshotSchema>;

export const IntakeSessionStatusSchema = z.enum(["queued", "running", "failed", "completed"]);
export type IntakeSessionStatus = z.infer<typeof IntakeSessionStatusSchema>;

export const IntakeBriefSchema = z.object({
  schemaVersion: z.literal("intake-brief/v1"),
  topic: z.string().min(3).max(500),
  learningLevel: z.string().min(2).max(120),
  domain: DomainSchema,
  audienceCategory: AudienceCategorySchema,
  durationSeconds: z.number().int().min(15).max(900),
  language: z.string().min(2).max(16),
  visualProfile: z.string().min(2).max(200),
});
export type IntakeBrief = z.infer<typeof IntakeBriefSchema>;

export const TextSourceInputSchema = z.object({
  kind: z.literal("text"),
  name: z.string().min(1).max(500),
  value: z.string().min(3).max(100_000),
});

export const UrlSourceInputSchema = z.object({
  kind: z.literal("url"),
  name: z.string().min(1).max(500),
  value: z.string().url(),
});

export const FileSourceInputSchema = z.object({
  kind: z.literal("file"),
  name: z.string().min(1).max(500),
  objectKey: z.string().min(1).max(1024),
  mimeType: z.enum(["text/plain", "text/markdown", "application/pdf"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().length(64),
  extractedText: z.string().min(3).max(100_000),
});

export const SourceInputSchema = z.discriminatedUnion("kind", [TextSourceInputSchema, UrlSourceInputSchema, FileSourceInputSchema]);
export type SourceInput = z.infer<typeof SourceInputSchema>;

export const IntakeSessionInputSchema = z.object({
  schemaVersion: z.literal("intake-session-input/v1"),
  requestText: z.string().min(3).max(20_000),
  language: z.string().min(2).max(16),
  source: SourceInputSchema,
});
export type IntakeSessionInput = z.infer<typeof IntakeSessionInputSchema>;

export const SourceEvidenceRefSchema = z.object({
  sourceId: z.string().uuid(),
  sourceHash: z.string().length(64),
  segmentIds: z.array(z.string().min(8)).min(1),
  locator: z.string().min(1),
});
export type SourceEvidenceRef = z.infer<typeof SourceEvidenceRefSchema>;

export const SourceSegmentSchema = z.object({
  id: z.string().min(8),
  sourceId: z.string().uuid(),
  sourceHash: z.string().length(64),
  ordinal: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  text: z.string(),
});
export type SourceSegment = z.infer<typeof SourceSegmentSchema>;

export const SourceEvidenceMapSchema = z.object({
  schemaVersion: z.literal("source-evidence-map/v1"),
  sources: z.array(z.object({
    sourceId: z.string().uuid(),
    sourceHash: z.string().length(64),
    segments: z.array(SourceSegmentSchema).min(1),
  })).min(1),
});
export type SourceEvidenceMap = z.infer<typeof SourceEvidenceMapSchema>;

export const ClaimVerificationSchema = z.object({
  schemaVersion: z.literal("claim-verification/v2"),
  evidence: z.array(z.object({
    claimId: z.string().uuid(),
    sourceId: z.string().uuid(),
    segmentIds: z.array(z.string().min(8)).min(1),
    supported: z.boolean(),
    rationale: z.string().min(1),
  })).min(1),
  notes: z.array(z.string()),
});
export type ClaimVerification = z.infer<typeof ClaimVerificationSchema>;

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  evidence: SourceEvidenceRefSchema,
  critical: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const FactPackSchema = z.object({
  schemaVersion: z.literal("fact-pack/v2"),
  claims: z.array(ClaimSchema).min(1),
  caveats: z.array(z.object({ text: z.string().min(1), evidence: SourceEvidenceRefSchema.optional() })),
});
export type FactPack = z.infer<typeof FactPackSchema>;

export const BlueprintSceneSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().nonnegative(),
  purpose: z.string().min(1),
  claimIds: z.array(z.string().uuid()),
  visualBeat: z.string().min(1),
});
export const BlueprintSchema = z.object({
  schemaVersion: z.literal("lesson-blueprint/v1"),
  objective: z.string().min(1),
  prerequisites: z.array(z.string()),
  scenes: z.array(BlueprintSceneSchema).min(1),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export const ScriptLineSchema = z.object({
  id: z.string().uuid(),
  sceneId: z.string().uuid(),
  text: z.string().min(1),
  claimIds: z.array(z.string().uuid()),
  visualAction: z.string().min(1),
});
export const ApprovedScriptSchema = z.object({
  schemaVersion: z.literal("approved-script/v2"),
  narration: z.array(ScriptLineSchema).min(1),
});
export type ApprovedScript = z.infer<typeof ApprovedScriptSchema>;

export const ScriptVerificationSchema = z.object({
  schemaVersion: z.literal("script-verification/v2"),
  evidence: z.array(z.object({ lineId: z.string().uuid(), supported: z.boolean(), unsupportedClaimIds: z.array(z.string().uuid()), rationale: z.string().min(1) })).min(1),
  notes: z.array(z.string()),
});
export type ScriptVerification = z.infer<typeof ScriptVerificationSchema>;
export const VisualBibleSchema = z.object({ schemaVersion: z.literal("visual-bible/v1"), canvasTexture: z.string().min(1), lineStyle: z.string().min(1), palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(2), typography: z.object({ heading: z.string().min(1), body: z.string().min(1), caption: z.string().min(1) }), captionSafeArea: z.object({ top: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0) }), persistentEntities: z.array(z.object({ id: z.string().min(1), description: z.string().min(1) })), camera: z.object({ behavior: z.string().min(1), transitions: z.array(z.string()) }), prohibitedVisualPatterns: z.array(z.string()) });
export type VisualBible = z.infer<typeof VisualBibleSchema>;

export const PointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type Point = z.infer<typeof PointSchema>;

export const AssetAnchorSchema = z.object({
  name: z.string().min(1),
  point: PointSchema,
  provider: z.enum(["svg", "mask", "landmark", "detection", "review"]),
  confidence: z.number().min(0).max(1).optional(),
});
export type AssetAnchor = z.infer<typeof AssetAnchorSchema>;

export const ScenePlanSchema = z.object({
  schemaVersion: z.literal("scene-plan/v1"),
  sceneId: z.string().uuid(),
  relations: z.array(
    z.object({
      relation: z.enum(["attach", "left-of", "right-of", "above", "below", "behind-mask", "must-not-overlap"]),
      subject: z.string().min(1),
      target: z.string().min(1),
      targetAnchor: z.string().optional(),
    }),
  ),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
export const SceneAssetBriefSchema = z.object({ schemaVersion: z.literal("scene-asset-brief/v1"), sceneId: z.string().uuid(), purpose: z.string().min(1), claimIds: z.array(z.string().uuid()), diagram: z.object({ kind: z.enum(["process", "comparison", "equation", "chart", "labelled-system", "none"]), title: z.string().optional(), labels: z.array(z.string()), values: z.array(z.number()).optional() }), illustration: z.object({ required: z.boolean(), prompt: z.string().min(1), role: z.enum(["character", "object", "texture", "none"]), prohibitedText: z.boolean(), reason: z.string().min(1).optional() }) });
export type SceneAssetBrief = z.infer<typeof SceneAssetBriefSchema>;

export const SoundChoiceSchema = z.object({
  choice: z.enum(["selected", "omitted"]),
  reason: z.string().min(1),
  description: z.string().min(1).optional(),
  assetId: z.string().uuid().optional(),
});
export type SoundChoice = z.infer<typeof SoundChoiceSchema>;

export const SceneSoundPlanSchema = z.object({
  sceneId: z.string().uuid(),
  music: SoundChoiceSchema,
  sfx: z.array(SoundChoiceSchema),
});
export type SceneSoundPlan = z.infer<typeof SceneSoundPlanSchema>;

export const SoundPlanSchema = z.object({
  schemaVersion: z.literal("sound-plan/v1"),
  /** Recorded ducking parameters so a future mix cannot bury narration. */
  ducking: z.object({ narrationGainDb: z.number().finite(), musicGainDb: z.number().finite() }),
  scenes: z.array(SceneSoundPlanSchema).min(1),
});
export type SoundPlan = z.infer<typeof SoundPlanSchema>;

export const ScenePlanBundleSchema = z.object({
  schemaVersion: z.literal("scene-plan-bundle/v1"),
  plans: z.array(ScenePlanSchema).min(1),
});
export type ScenePlanBundle = z.infer<typeof ScenePlanBundleSchema>;

export const SceneAssetBriefBundleSchema = z.object({
  schemaVersion: z.literal("scene-asset-brief-bundle/v1"),
  briefs: z.array(SceneAssetBriefSchema).min(1),
});
export type SceneAssetBriefBundle = z.infer<typeof SceneAssetBriefBundleSchema>;

export const DiagramKindSchema = z.enum(["process", "comparison", "equation", "chart", "labelled-system", "none"]);
export type DiagramKind = z.infer<typeof DiagramKindSchema>;

/**
 * A typed, deterministic diagram description. Labels and values are derived
 * only from locked source/claim/script text: image models never draw factual
 * diagrams, and the renderer never invents a label.
 */
export const DiagramModelSchema = z.object({
  schemaVersion: z.literal("diagram-model/v1"),
  sceneId: z.string().uuid(),
  kind: DiagramKindSchema,
  title: z.string().min(1).max(160),
  /** Human-readable step/axis/entity labels taken verbatim from locked text. */
  labels: z.array(z.string().min(1).max(60)).max(6),
  /** Numeric values taken verbatim from locked source text; empty when none exist. */
  values: z.array(z.number().finite()).max(6),
  /** Exact locked-text expression for `equation` diagrams. */
  expression: z.string().min(1).max(240).optional(),
  /** Locked claim IDs this diagram visualises. */
  claimIds: z.array(z.string().uuid()),
});
export type DiagramModel = z.infer<typeof DiagramModelSchema>;

export const DiagramAnchorSchema = z.object({
  name: z.string().min(1).max(120),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type DiagramAnchorPoint = z.infer<typeof DiagramAnchorSchema>;

export const ResolvedLayerSchema = z.object({
  id: z.string().min(1),
  matrix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  zIndex: z.number().int(),
  clipPath: z.string().optional(),
});
export type ResolvedLayer = z.infer<typeof ResolvedLayerSchema>;
export const ResolvedLayoutSchema = z.object({
  schemaVersion: z.literal("resolved-layout/v1"),
  sceneId: z.string().uuid(),
  canvas: z.object({ width: z.number().positive(), height: z.number().positive() }),
  layers: z.array(ResolvedLayerSchema),
});
export type ResolvedLayout = z.infer<typeof ResolvedLayoutSchema>;

export const WordTimingSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});
export const CaptionCueSchema = z.object({ text: z.string().min(1), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), wordIndexes: z.array(z.number().int().nonnegative()).min(1) });
export type WordTiming = z.infer<typeof WordTimingSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const ProjectManifestSchema = z.object({
  safeArea: z.object({ top: z.number().nonnegative(), right: z.number().nonnegative(), bottom: z.number().nonnegative(), left: z.number().nonnegative() }),
  schemaVersion: z.literal("video-manifest/v1"),
  fps: z.literal(30),
  canvas: z.object({ width: z.number().positive(), height: z.number().positive() }),
  narrationAssetId: z.string().uuid(),
  words: z.array(WordTimingSchema),
  captions: z.array(CaptionCueSchema),
  scenes: z.array(z.object({ sceneId: z.string().uuid(), layoutArtifactId: z.string().uuid(), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), title: z.string().min(1), visualBeat: z.string().min(1), layers: z.array(z.object({ id: z.string().min(1), kind: z.enum(["background", "diagram", "illustration", "effect"]), assetId: z.string().uuid().optional(), assetUrl: z.string().url().optional(), color: z.string().optional(), text: z.string().optional(), zIndex: z.number().int(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }) })) })),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const QaSeveritySchema = z.enum(["info", "warning", "critical"]);
export const QaFindingSchema = z.object({
  rule: z.string().min(1),
  severity: QaSeveritySchema,
  evidence: z.record(z.string(), z.unknown()),
  remediation: z.string().min(1),
});
export type QaFinding = z.infer<typeof QaFindingSchema>;

export const PedagogyReviewSchema = z.object({
  schemaVersion: z.literal("pedagogy-review/v1"),
  objectiveCovered: z.boolean(),
  oneIdeaPerBeat: z.boolean(),
  readingLevelAppropriate: z.boolean(),
  issues: z.array(z.object({
    severity: z.enum(["info", "warning", "critical"]),
    evidence: z.string().min(1),
    remediation: z.string().min(1),
  })),
});
export type PedagogyReview = z.infer<typeof PedagogyReviewSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reviewerId: z.string().min(1),
  notes: z.string().max(2_000).default(""),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const CreateRunInputSchema = InputSnapshotSchema.omit({
  schemaVersion: true,
  sourceIds: true,
}).extend({
  sourceIds: z.array(z.string().uuid()).default([]),
  sources: z.array(SourceInputSchema).min(1, "At least one source is required for a source-grounded lesson."),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export const ViewerOutcomeInputSchema = z.object({
  schemaVersion: z.literal("viewer-outcome/v1"),
  kind: z.enum(["retention", "scene-drop", "rewatch", "quiz", "teacher-feedback", "reviewer-feedback"]),
  segment: z.string().min(1).max(200).optional(),
  metric: z.string().min(1).max(200),
  value: z.number().finite(),
  unit: z.string().min(1).max(40).optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type ViewerOutcomeInput = z.infer<typeof ViewerOutcomeInputSchema>;

export const RunEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  stage: StageNameSchema.nullable(),
  type: z.enum(["status", "stage_started", "stage_completed", "stage_failed", "qa", "approval", "render"]),
  message: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const STAGE_ORDER: readonly StageName[] = [
  "preflight", "research", "fact-verification", "blueprint", "script", "visual-bible",
  "assets", "voiceover", "captions", "spatial-layout", "manifest", "preview-render",
  "qa", "approval", "final-render", "release-record",
] as const;
