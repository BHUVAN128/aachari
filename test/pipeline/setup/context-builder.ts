import { getDb } from "@upcraft/db";
import { getArtifact, requireContent, saveArtifact, validationFeedback } from "@upcraft/pipeline/stages";
import { failWithFindings, recordUsage, stageRoute } from "@upcraft/pipeline/stages";
import type { StageContext } from "@upcraft/pipeline/pipeline";
import { STAGE_CAPABILITIES } from "@upcraft/providers";
import type { StageName } from "@upcraft/contracts";

/**
 * Builds a real `StageContext` for a single step so the production stage handler
 * runs unmodified. The only difference from the executor-built context is that
 * the run identity is supplied by the harness; every service (`saveArtifact`,
 * `recordUsage`, `getDb`, routing) is the production implementation pointed at
 * the harness database.
 */
export const buildStageContext = (runId: string, stage: StageName): StageContext => ({
  runId,
  stage,
  route: stageRoute,
  saveArtifact,
  getArtifact,
  requireContent,
  validationFeedback,
  recordUsage,
  failWithFindings,
  db: getDb(),
});

/** The capability a stage routes to, or null when the stage is deterministic. */
export const stageCapability = (stage: StageName) => STAGE_CAPABILITIES[stage];