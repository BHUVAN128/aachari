import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb, intakeSessions, outbox, stageCheckpoints, videoRuns } from "@upcraft/db";
import type { StageName } from "@upcraft/contracts";
import { enqueueIntakeSession, enqueueStage } from "./queue.ts";

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

/** Recovers a crash between initial run reservation and its outbox insert. */
export const recoverReservedRuns = async () => {
  const db = getDb();
  const now = new Date();
  const runs = await db.select({ id: videoRuns.id }).from(videoRuns).where(eq(videoRuns.status, "queued")).limit(100);
  for (const run of runs) await db.insert(outbox).values({ topic: pipelineTopic, key: `${run.id}--preflight`, payload: { runId: run.id, stage: "preflight", dispatchKey: "initial" } }).onConflictDoNothing();
  const expired = await db.select().from(stageCheckpoints).where(and(eq(stageCheckpoints.outcome, "running"), lt(stageCheckpoints.leaseExpiresAt, now))).limit(100);
  for (const checkpoint of expired) {
    await db.update(stageCheckpoints).set({ outcome: "failed", leaseToken: null, leaseOwner: null, leaseExpiresAt: null, evidence: { ...checkpoint.evidence, recoveredAt: now.toISOString(), recoveryReason: "expired_stage_lease" }, updatedAt: now }).where(and(eq(stageCheckpoints.id, checkpoint.id), eq(stageCheckpoints.outcome, "running")));
    await scheduleStage(checkpoint.runId, checkpoint.stage, `recovery-${checkpoint.attemptCount + 1}`);
  }
  const activeRuns = await db.select({ id: videoRuns.id, currentStage: videoRuns.currentStage }).from(videoRuns).where(eq(videoRuns.status, "running")).limit(100);
  for (const run of activeRuns) {
    if (!run.currentStage) continue;
    const checkpoint = await db.query.stageCheckpoints.findFirst({ where: and(eq(stageCheckpoints.runId, run.id), eq(stageCheckpoints.stage, run.currentStage)) });
    if (checkpoint?.outcome === "running" && checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > now) continue;
    await scheduleStage(run.id, run.currentStage, `recovery-${(checkpoint?.attemptCount ?? 0) + 1}`);
  }
  const sessions = await db.select({ id: intakeSessions.id, status: intakeSessions.status }).from(intakeSessions).where(inArray(intakeSessions.status, ["queued", "running"])).limit(100);
  for (const session of sessions) if (session.status === "running") await db.update(intakeSessions).set({ status: "queued", updatedAt: new Date() }).where(and(eq(intakeSessions.id, session.id), eq(intakeSessions.status, "running")));
  for (const session of sessions) await db.insert(outbox).values({ topic: intakeTopic, key: session.id, payload: { sessionId: session.id } }).onConflictDoNothing();
  await dispatchScheduledMessages();
};
