import { and, eq, like } from "drizzle-orm";
import { STAGE_ORDER, type StageName } from "@upcraft/contracts";
import { approvals, getDb, mediaAssets } from "@upcraft/db";
import { ProviderError } from "@upcraft/providers";
import { appendRunEvent, claimStageLease, checkpointStage, getRun, setRunStatus, StageLeaseLostError, startStageLeaseHeartbeat } from "../runs.ts";
import { scheduleStage } from "../outbox.ts";
import { getArtifact, recordInvalidArtifactAttempt, requireContent, saveArtifact, validationFeedback } from "../artifacts/store.ts";
import { sha } from "../artifacts/hashing.ts";
import { failWithFindings, recordUsage } from "../usage.ts";
import { stageRoute } from "../routing.ts";
import { stageHandlers } from "./registry.ts";
import { getStageInputHash } from "./input-hash.ts";
import { decideInvalidArtifactRetry, isArtifactValidationFailure } from "./retry-policy.ts";
import type { StageContext } from "./context.ts";

const nextStage = (stage: StageName): StageName | undefined => {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 ? STAGE_ORDER[index + 1] : undefined;
};

/**
 * Lease claim/heartbeat/checkpoint/retry classification is cross-stage policy,
 * not a stage. Keeping it here, away from stage implementations, preserves the
 * `StageLeaseLostError` semantics and the visible-failure behavior exactly.
 */
export const processPipelineStage = async (runId: string, stage: StageName) => {
  const run = await getRun(runId);
  if (!run || run.status === "completed") return;
  if (stage === "approval") return;
  const owner = process.env.PIPELINE_WORKER_ID ?? `worker-${process.pid}`;
  const inputHash = await getStageInputHash(runId, stage);
  const lease = await claimStageLease({ runId, stage, inputHash, owner });
  if (!lease) return;
  const leaseHeartbeat = startStageLeaseHeartbeat({ runId, stage, leaseToken: lease.leaseToken, owner });
  // Resolve and freeze the stage route at claim time so the checkpoint records
  // exactly which provider/model served this attempt, independent of later env changes.
  const modelRoute = stageRoute(stage);
  await setRunStatus(runId, "running", { stage });
  await appendRunEvent(runId, stage, "stage_started", `${stage} started.`, {});
  const stageStartedAt = Date.now();
  try {
    const handler = stageHandlers[stage];
    if (!handler) throw new Error(`No stage handler registered for ${stage}`);
    const ctx: StageContext = { runId, stage, route: stageRoute, saveArtifact, getArtifact, requireContent, validationFeedback, recordUsage, failWithFindings, db: getDb() };
    const result = await handler(ctx);

    // Fence the stage result before checkpointing: a reclaimed lease means
    // this worker's output is stale and cannot advance the pipeline.
    await leaseHeartbeat.stop();
    const outputHash = result && typeof result === "object" && "sha256" in result && typeof result.sha256 === "string" ? result.sha256 : sha(result);
    await checkpointStage({ runId, stage, inputHash, outputHash, outcome: "valid", leaseToken: lease.leaseToken, leaseOwner: owner, ...(modelRoute ? { modelRoute } : {}), evidence: { stageInputHash: inputHash, leaseExpiresAt: lease.leaseExpiresAt.toISOString() } });
    await appendRunEvent(runId, stage, "stage_completed", `${stage} completed.`, {});
    const next = nextStage(stage);
    if (next === "approval") {
      const illustrationCount = (await getDb().select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true), like(mediaAssets.role, "illustration-%")))).length;
      if (illustrationCount > 0) await appendRunEvent(runId, "approval", "qa", "Selected AI illustrations require reviewer approval before publication.", { illustrationCount });
      const automatic = run.domain === "standard" && ["school", "college"].includes(run.snapshot.audienceCategory) && illustrationCount === 0;
      if (automatic) {
        await getDb().insert(approvals).values({ runId, decision: "approved", reviewerId: "automated-release-gates", notes: "Automated standard school/college release gates passed." });
        await setRunStatus(runId, "running", { stage: "final-render" });
        await checkpointStage({ runId, stage: "approval", inputHash: await getStageInputHash(runId, "approval"), outputHash: sha({ decision: "approved", reviewerId: "automated-release-gates" }), outcome: "valid" });
        await appendRunEvent(runId, "approval", "approval", "Automated release gates approved the run for final render.", { reviewerId: "automated-release-gates" });
        await scheduleStage(runId, "final-render");
        return;
      }
      await setRunStatus(runId, "awaiting_approval", { stage: "approval" });
      await checkpointStage({ runId, stage: "approval", inputHash: await getStageInputHash(runId, "approval"), outcome: "awaiting_approval" });
      await appendRunEvent(runId, "approval", "status", "Run is awaiting approval.", {});
      return;
    }
    if (next) await scheduleStage(runId, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown pipeline error";
    if (error instanceof StageLeaseLostError) {
      await appendRunEvent(runId, stage, "status", `${stage} lease ownership was lost; this worker did not promote its result.`, { code: "STAGE_LEASE_LOST" });
      return;
    }
    const route = modelRoute;
    if (route && route.provider !== "deterministic") await recordUsage(runId, stage, route.provider, route.model, stageStartedAt, { model: route.model }, `${stage}/v2`, { projection: "unknown-at-failure" }, "failed", error instanceof ProviderError ? error.code : "VALIDATION_OR_STAGE_ERROR");    if (error instanceof ProviderError && error.retryable) {
      await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", ...(modelRoute ? { modelRoute } : {}), evidence: { message, retryable: true, providerCode: error.code, attempt: lease.attemptCount } });
      await setRunStatus(runId, "queued", { stage });
      await appendRunEvent(runId, stage, "status", `${stage} will retry after a transient provider failure: ${message}`, { code: error.code, status: error.status ?? null });
      throw error;
    }
    const invalidArtifact = decideInvalidArtifactRetry({ attemptCount: lease.attemptCount, error });
    if (invalidArtifact.regenerate) {
      await recordInvalidArtifactAttempt({ runId, stage, inputHash, error, attempt: lease.attemptCount });
      await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", ...(modelRoute ? { modelRoute } : {}), evidence: { message, retryable: true, attempt: lease.attemptCount, validationError: message } });
      await setRunStatus(runId, "queued", { stage });
      await appendRunEvent(runId, stage, "status", `${stage} produced an invalid artifact and will regenerate.`, { attempt: lease.attemptCount, validationError: message });
      await scheduleStage(runId, stage, `validation-${invalidArtifact.nextAttempt}`);
      return;
    }
    if (isArtifactValidationFailure(error)) await recordInvalidArtifactAttempt({ runId, stage, inputHash, error, attempt: lease.attemptCount });
    await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", ...(modelRoute ? { modelRoute } : {}), evidence: { message, stageInputHash: inputHash } });
    await setRunStatus(runId, "failed", { stage, failureCode: "STAGE_FAILED", failureMessage: message });
    await appendRunEvent(runId, stage, "stage_failed", `${stage} failed: ${message}`, {});
    // Terminal validation and configuration failures are persisted outcomes. They
    // must not consume BullMQ retries; only classified transient provider failures
    // are rethrown above.
    return;
  } finally {
    // `stop` is idempotent.  Suppress its lease-loss error here because the
    // success/catch paths above make the ownership decision explicitly.
    await leaseHeartbeat.stop().catch(() => undefined);
  }
};