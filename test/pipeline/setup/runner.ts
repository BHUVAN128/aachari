import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { artifacts, getDb, stageCheckpoints, videoRuns } from "@upcraft/db";
import type { StageName } from "@upcraft/contracts";
import { requiredCredentials, resolveModelRoute, STAGE_CAPABILITIES } from "@upcraft/providers";
import { createVideoRun } from "@upcraft/pipeline";
import { processPipelineStage } from "@upcraft/pipeline/pipeline";
import { buildRunInput, type HarnessInputName } from "./inputs.ts";
import { createLogger, printSummary, type CheckpointOutcome, type StepSummary } from "./logger.ts";

const ARTIFACTS_ROOT = fileURLToPath(new URL("../artifacts", import.meta.url));

export type StepRunResult = {
  runId: string;
  stage: StageName;
  checkpointOutcome: CheckpointOutcome;
  failureCode: string | null;
  failureMessage: string | null;
  blockReason: string | null;
  summary: StepSummary | null;
};

/**
 * Runs a single pipeline stage against the harness database using the real
 * production handler. The harness must never hide a missing credential: when the
 * stage's capability has no credentials the run is recorded as `blocked` with a
 * visible reason instead of silently skipping.
 */
export const runStage = async (params: {
  stage: StageName;
  input: HarnessInputName;
  runId?: string;
  /** Optional verifier/transport shims installed before the stage handler runs. */
  install?: (runId: string) => void | Promise<void>;
  /** When true, do not fail the process when the run is visibly blocked. */
  allowBlocked?: boolean;
}): Promise<StepRunResult> => {
  const capability = STAGE_CAPABILITIES[params.stage];
  const providedRun = Boolean(params.runId);
  const runId = params.runId ?? randomUUID();
  const logger = await createLogger(runId, params.stage);

  if (capability) {
    const missing = requiredCredentials(capability).filter((name) => !process.env[name]?.trim());
    if (missing.length) {
      const reason = `capability "${capability}" is unavailable: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`;
      await logger.session(`BLOCKED ${reason}`);
      console.log(`[${params.stage}] BLOCKED: ${reason}`);
      return { runId, stage: params.stage, checkpointOutcome: "blocked", failureCode: "MISSING_CREDENTIALS", failureMessage: reason, blockReason: reason, summary: null };
    }
  }

  if (!providedRun) await createVideoRun(await buildRunInput(params.input));
  await params.install?.(runId);

  let thrown: unknown = null;
  try {
    await processPipelineStage(runId, params.stage);
  } catch (error) {
    thrown = error;
  }

  const checkpoint = await getDb().query.stageCheckpoints.findFirst({ where: eq(stageCheckpoints.runId, runId) });
  const checkpointOutcome: CheckpointOutcome = checkpoint ? (checkpoint.outcome === "valid" || checkpoint.outcome === "failed" || checkpoint.outcome === "awaiting_approval" ? checkpoint.outcome : "blocked") : thrown ? "failed" : "skipped";
  const artifactRows = await getDb().select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.status, "valid"))).orderBy(desc(artifacts.createdAt)).limit(1).then((rows) => rows[0]);
  const route = capability ? resolveModelRoute(capability) : undefined;
  const summary = await logger.capture({ checkpointOutcome, artifactRole: artifactRows?.role ?? null, artifactSha256: artifactRows?.sha256 ?? null, modelRef: route?.modelRef ?? null });

  if (artifactRows?.content) {
    const dir = join(ARTIFACTS_ROOT, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${params.stage}.json`), JSON.stringify({ role: artifactRows.role, schemaVersion: artifactRows.schemaVersion, sha256: artifactRows.sha256, content: artifactRows.content }, null, 2), "utf8");
  }

  printSummary(summary);
  if (thrown && !params.allowBlocked) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const failure = await getDb().select().from(videoRuns).where(eq(videoRuns.id, runId)).limit(1).then((rows) => rows[0]);
    console.log(`[${params.stage}] run failed visibly: ${message}`);
    return { runId, stage: params.stage, checkpointOutcome: "failed", failureCode: failure?.failureCode ?? "STAGE_FAILED", failureMessage: failure?.failureMessage ?? message, blockReason: null, summary };
  }
  return { runId, stage: params.stage, checkpointOutcome, failureCode: null, failureMessage: null, blockReason: null, summary };
};

export const artifactFor = async (runId: string, role: string) => {
  const { getArtifact } = await import("@upcraft/pipeline/stages");
  return getArtifact(runId, role);
};