import { STAGE_ORDER, type StageName } from "@upcraft/contracts";

/**
 * Pure recovery decisions for the Reliability contract in
 * `docs/video-generation-process.md`: a restart or expired lease must recover
 * from the latest valid checkpoint or leave the run visibly failed, and must
 * never appear successful. Keeping the decisions pure lets the regression suite
 * prove crash/expiry behaviour without a live queue or worker.
 */
export type CheckpointRecoveryView = {
  outcome: string;
  leaseExpiresAt: Date | null;
  attemptCount: number;
};

export type StageRecoveryDecision =
  | { action: "resume"; dispatchKey: string; reason: "missing_checkpoint" | "checkpoint_not_owned" }
  | { action: "recover_expired_lease"; dispatchKey: string; reason: "expired_lease"; attemptCount: number };

export type RunRecoveryDecision =
  | { action: "resume_preflight"; reason: "queued_before_outbox" }
  | { action: "resume_stage"; stage: StageName; dispatchKey: string; reason: string }
  | { action: "advance_stage"; stage: StageName; dispatchKey: string; reason: "completed_stage_checkpoint" }
  | { action: "complete_run"; reason: "terminal_stage_checkpoint_valid" }
  | { action: "fail_visible"; reason: "running_without_stage" };

export const nextStageAfter = (stage: StageName): StageName | undefined => {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 ? STAGE_ORDER[index + 1] : undefined;
};

export const recoveryDispatchKey = (attemptCount: number) => `recovery-${Math.max(1, attemptCount + 1)}`;

/**
 * Decides what to do with a run's currently owned stage. Returns `null` when an
 * unexpired lease proves another worker still owns the stage, so recovery must
 * not steal or duplicate it.
 */
export const decideStageRecovery = (params: {
  now: Date;
  checkpoint?: CheckpointRecoveryView | null;
}): StageRecoveryDecision | null => {
  const checkpoint = params.checkpoint;
  if (!checkpoint) return { action: "resume", dispatchKey: "recovery-1", reason: "missing_checkpoint" };
  if (checkpoint.outcome === "running") {
    if (checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt.getTime() > params.now.getTime()) return null;
    return {
      action: "recover_expired_lease",
      dispatchKey: recoveryDispatchKey(checkpoint.attemptCount),
      reason: "expired_lease",
      attemptCount: checkpoint.attemptCount,
    };
  }
  // The stage produced a checkpoint but its downstream dispatch was lost
  // (crash between checkpoint write and outbox insert). Re-drive the stage from
  // that locked checkpoint instead of the whole run.
  return { action: "resume", dispatchKey: recoveryDispatchKey(checkpoint.attemptCount), reason: "checkpoint_not_owned" };
};

/** Decides whether a run needs re-driving or a visible terminal failure. */
export const decideRunRecovery = (params: {
  now: Date;
  run: { status: string; currentStage: StageName | null };
  checkpoint?: CheckpointRecoveryView | null;
}): RunRecoveryDecision | null => {
  if (params.run.status === "queued") return { action: "resume_preflight", reason: "queued_before_outbox" };
  if (params.run.status !== "running") return null;
  if (!params.run.currentStage) return { action: "fail_visible", reason: "running_without_stage" };
  const checkpoint = params.checkpoint;
  if (checkpoint?.outcome === "valid") {
    // The stage committed its checkpoint but the crash happened before the next
    // stage was dispatched. Re-running it would be refused as a duplicate, so
    // advance instead. A valid terminal checkpoint means the run finished.
    const next = nextStageAfter(params.run.currentStage);
    if (next) return { action: "advance_stage", stage: next, dispatchKey: "recovery-advance", reason: "completed_stage_checkpoint" };
    return { action: "complete_run", reason: "terminal_stage_checkpoint_valid" };
  }
  if (checkpoint?.outcome === "awaiting_approval") return null;
  const stageDecision = decideStageRecovery({ now: params.now, checkpoint: checkpoint ?? null });
  if (!stageDecision) return null;
  return { action: "resume_stage", stage: params.run.currentStage, dispatchKey: stageDecision.dispatchKey, reason: stageDecision.reason };
};

/**
 * True when an expired checkpoint row must be swept back to `failed` before a
 * new bounded attempt is scheduled, so the run cannot look successful.
 */
export const shouldSweepExpiredCheckpoint = (params: {
  now: Date;
  checkpoint: { outcome: string; leaseExpiresAt: Date | null };
}) => params.checkpoint.outcome === "running" && (!params.checkpoint.leaseExpiresAt || params.checkpoint.leaseExpiresAt.getTime() <= params.now.getTime());
