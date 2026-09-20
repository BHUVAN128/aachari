/**
 * @deprecated since the stage-level modularization.
 *
 * `stages.ts` used to own 11 stage handlers, rendering, QA orchestration, and the
 * release record in one file. The pipeline now lives in `./pipeline/` with one
 * module per governing stage. This file is a compatibility shim so existing
 * consumers (`@upcraft/pipeline/stages`, tests, and `apps/worker`) keep working
 * without a coordinated migration. It will be deleted in a later cleanup phase;
 * import from `@upcraft/pipeline/pipeline` or a specific stage module instead.
 */
export { processPipelineStage } from "./pipeline/executor.ts";
export { getStageInputHash } from "./pipeline/input-hash.ts";
export { resolveStageRoute, stageRoute } from "./routing.ts";
export { withFallback } from "./fallback.ts";
export { MAX_ARTIFACT_ATTEMPTS, decideInvalidArtifactRetry, isArtifactValidationFailure } from "./pipeline/retry-policy.ts";
export { getArtifact, saveArtifact, recordInvalidArtifactAttempt, validationFeedback, requireContent, missingRenderAssets } from "./artifacts/store.ts";
export { sceneDiagramArea } from "./pipeline/scene-area.ts";
export { recordUsage, failWithFindings } from "./usage.ts";