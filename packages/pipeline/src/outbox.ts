import { and, eq, inArray, isNull, lt, max } from "drizzle-orm";
import { getDb, intakeSessions, outbox, runEvents, stageCheckpoints, videoRuns } from "@upcraft/db";
import type { StageName } from "@upcraft/contracts";
import { enqueueIntakeSession, enqueueStage, publishRunSignal } from "./queue.ts";
import { decideRunRecovery, recoveryDispatchKey, shouldSweepExpiredCheckpoint } from "./recovery.ts";

const pipelineTopic = "pipeline.stage";
const intakeTopic = "intake.session";

export const scheduleStage = async (runId: string, stage: StageName, dispatchKey?: string) => {
  const db = getDb();
  const key = dispatchKey ? `${runId}--${stage}--${dispatchKey}` : `${runId}--${stage}`;
  await db.insert(outbox).values({ topic: pipelineTopic, key, payload: { runId, stage, dispatchKey: dispatchKey ?? "initial" } }).onConflictDoNothing();
  await dispatchScheduledMessages();
};

export const scheduleIntakeSession = async (sessionId: string) => {
  const db = getDb();
  await db.insert(outbox).values({ topic: intakeTopic, key: sessionId, payload: { sessionId } }).onConflictDoNothing();
  await dispatchScheduledMessages();
};

/** PostgreSQL is the source of truth; BullMQ is only the retrying dispatcher. */
export const dispatchScheduledMessages = async () => {
  const db = getDb();
  const pending = await db.select().from(outbox).where(and(inArray(outbox.topic, [pipelineTopic, intakeTopic]), isNull(outbox.publishedAt))).limit(100);
  for (const message of pending) {
    if (message.topic === pipelineTopic) {
      const payload = message.payload as { runId?: unknown; stage?: unknown; dispatchKey?: unknown };
      if (typeof payload.runId !== "string" || typeof payload.stage !== "string") throw new Error(`Invalid outbox payload ${message.id}`);
      await enqueueStage(payload.runId, payload.stage as StageName, typeof payload.dispatchKey === "string" ? payload.dispatchKey : "initial");
    } else {
      const payload = message.payload as { sessionId?: unknown };
      if (typeof payload.sessionId !== "string") throw new Error(`Invalid intake outbox payload ${message.id}`);
      await enqueueIntakeSession(payload.sessionId);
    }
    await db.update(outbox).set({ publishedAt: new Date() }).where(and(eq(outbox.id, message.id), isNull(outbox.publishedAt)));
  }
};

export const dispatchScheduledStages = dispatchScheduledMessages;

/** Writes a visible terminal state and event for recovery that cannot resume. */
const markRunRecoveryFailure = async (runId: string, failureCode: string, message: string) => {
  const db = getDb();
  const now = new Date();
  await db.update(videoRuns).set({ status: "failed", currentStage: null, failureCode, failureMessage: message, updatedAt: now, completedAt: null }).where(and(eq(videoRuns.id, runId), inArray(videoRuns.status, ["queued", "running"])));
  const next = await db.select({ sequence: max(runEvents.sequence) }).from(runEvents).where(eq(runEvents.runId, runId));
  await db.insert(runEvents).values({ runId, sequence: (next[0]?.sequence ?? 0) + 1, stage: null, type: "stage_failed", message, data: { failureCode, recovery: true } }).onConflictDoNothing();
  await publishRunSignal(runId);
};

/** Marks a run completed when its terminal stage checkpoint is already valid. */
const markRunRecoveryComplete = async (runId: string) => {
  const db = getDb();
  const now = new Date();
  await db.update(videoRuns).set({ status: "completed", currentStage: null, failureCode: null, failureMessage: null, updatedAt: now, completedAt: now }).where(and(eq(videoRuns.id, runId), eq(videoRuns.status, "running")));
  await publishRunSignal(runId);
};

/**
 * Recovers work lost to a crash: a run reserved before its outbox insert, a
 * stage whose lease expired, a stage whose checkpoint committed but whose
 * downstream dispatch never happened, and an intake session left running.
 */
export const recoverReservedRuns = async () => {
  const db = getDb();
  const now = new Date();

  // Expired leases are swept to `failed` before a new bounded attempt is
  // scheduled, so the run can never appear successful.
  const expired = await db.select().from(stageCheckpoints).where(and(eq(stageCheckpoints.outcome, "running"), lt(stageCheckpoints.leaseExpiresAt, now))).limit(100);
  for (const checkpoint of expired) {
    if (!shouldSweepExpiredCheckpoint({ now, checkpoint })) continue;
    await db.update(stageCheckpoints).set({ outcome: "failed", leaseToken: null, leaseOwner: null, leaseExpiresAt: null, evidence: { ...checkpoint.evidence, recoveredAt: now.toISOString(), recoveryReason: "expired_stage_lease" }, updatedAt: now }).where(and(eq(stageCheckpoints.id, checkpoint.id), eq(stageCheckpoints.outcome, "running")));
    await scheduleStage(checkpoint.runId, checkpoint.stage, recoveryDispatchKey(checkpoint.attemptCount));
  }

  const runs = await db.select({ id: videoRuns.id, status: videoRuns.status, currentStage: videoRuns.currentStage }).from(videoRuns).where(inArray(videoRuns.status, ["queued", "running"])).limit(100);
  for (const run of runs) {
    const checkpoint = run.status === "running" && run.currentStage
      ? await db.query.stageCheckpoints.findFirst({ where: and(eq(stageCheckpoints.runId, run.id), eq(stageCheckpoints.stage, run.currentStage)) })
      : null;
    const decision = decideRunRecovery({ now, run, checkpoint: checkpoint ?? null });
    if (!decision) continue;
    if (decision.action === "resume_preflight") {
      await db.insert(outbox).values({ topic: pipelineTopic, key: `${run.id}--preflight`, payload: { runId: run.id, stage: "preflight", dispatchKey: "initial" } }).onConflictDoNothing();
      continue;
    }
    if (decision.action === "fail_visible") {
      await markRunRecoveryFailure(run.id, "RECOVERY_WITHOUT_STAGE", "Run was running without a current stage and cannot resume from a checkpoint.");
      continue;
    }
    if (decision.action === "complete_run") {
      await markRunRecoveryComplete(run.id);
      continue;
    }
    await scheduleStage(run.id, decision.stage, decision.dispatchKey);
  }

  const sessions = await db.select({ id: intakeSessions.id, status: intakeSessions.status }).from(intakeSessions).where(inArray(intakeSessions.status, ["queued", "running"])).limit(100);
  for (const session of sessions) if (session.status === "running") await db.update(intakeSessions).set({ status: "queued", updatedAt: new Date() }).where(and(eq(intakeSessions.id, session.id), eq(intakeSessions.status, "running")));
  for (const session of sessions) await db.insert(outbox).values({ topic: intakeTopic, key: session.id, payload: { sessionId: session.id } }).onConflictDoNothing();
  await dispatchScheduledMessages();
};
