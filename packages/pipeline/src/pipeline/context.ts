import type { getDb } from "@upcraft/db";
import type { ModelRoute, StageName } from "@upcraft/contracts";
import type { getArtifact, requireContent, saveArtifact, validationFeedback } from "../artifacts/store.ts";
import type { recordUsage, failWithFindings } from "../usage.ts";

/**
 * The one explicit service surface a stage handler receives. It removes the
 * shared-closure coupling that previously forced every stage into a single file:
 * a stage module imports only the helpers it needs, and the executor supplies the
 * run identity and cross-stage services.
 *
 * This is a type-only contract; it introduces no behavior and no runtime cycle.
 */
export type StageContext = {
  runId: string;
  stage: StageName;
  route: (stage: StageName) => ModelRoute | undefined;
  saveArtifact: typeof saveArtifact;
  getArtifact: typeof getArtifact;
  requireContent: typeof requireContent;
  validationFeedback: typeof validationFeedback;
  recordUsage: typeof recordUsage;
  failWithFindings: typeof failWithFindings;
  db: ReturnType<typeof getDb>;
};

export type StageHandler = (ctx: StageContext) => Promise<unknown>;