import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import { CreateRunInputSchema, InputSnapshotSchema, type CreateRunInput, type InputSnapshot, type ModelRoute, type RunEvent, type RunStatus, type StageName } from "@upcraft/contracts";
import { getDb, outbox, providerUsage, runEvents, sourceDocuments, stageCheckpoints, videoRuns } from "@upcraft/db";
import { publishRunSignal } from "./queue.ts";
import { scheduleStage } from "./outbox.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const createVideoRun = async (rawInput: CreateRunInput) => {
  const input = CreateRunInputSchema.parse(rawInput);
  const db = getDb();
  const runId = randomUUID();
  const sourceIds = input.sources.map(() => randomUUID());
  const snapshot = InputSnapshotSchema.parse({
    ...input,
    schemaVersion: "input-snapshot/v1",
    sourceIds,
  });

  await db.transaction(async (tx) => {
    await tx.insert(videoRuns).values({
      id: runId,
      title: input.topic,
      domain: input.domain,
      snapshot,
      snapshotHash: hash(snapshot),
      status: "queued",
    });
    if (input.sources.length) await tx.insert(sourceDocuments).values(input.sources.map((source, index) => {
      const extractedText = source.kind === "url" ? null : source.kind === "file" ? source.extractedText : source.value;
      const sourceValue = source.kind === "file" ? source.extractedText : source.value;
      const contentHash = createHash("sha256").update(extractedText ?? sourceValue).digest("hex");
      const sourceBytesSha256 = source.kind === "file" ? source.sha256 : createHash("sha256").update(source.value).digest("hex");
      return {
        id: sourceIds[index]!, runId, kind: source.kind, originalName: source.name,
        objectKey: source.kind === "file" ? source.objectKey : null,
        sourceUrl: source.kind === "url" ? source.value : null,
        extractedText,
        sha256: contentHash,
        sourceBytesSha256,
        mimeType: source.kind === "file" ? source.mimeType : source.kind === "url" ? "text/uri-list" : "text/plain",
        retrievedAt: source.kind === "url" ? null : new Date(),
      };
    }));
    await tx.insert(outbox).values({ topic: "pipeline.stage", key: `${runId}--preflight`, payload: { runId, stage: "preflight" } });
  });
  await appendRunEvent(runId, null, "status", "Run queued and input snapshot frozen.", { status: "queued" });
  await scheduleStage(runId, "preflight");
  return runId;
};

export const appendRunEvent = async (
  runId: string,
  stage: StageName | null,
  type: RunEvent["type"],
  message: string,
  data: Record<string, unknown> = {},
) => {
  const db = getDb();
  await db.transaction(async (tx) => {
    // A per-run advisory lock gives the externally streamed event log a stable order
    // even when a retry and a UI mutation arrive at the same time.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    const result = await tx.select({ next: max(runEvents.sequence) }).from(runEvents).where(eq(runEvents.runId, runId));
    const sequence = (result[0]?.next ?? 0) + 1;
    await tx.insert(runEvents).values({ runId, sequence, stage, type, message, data });
  });
  await publishRunSignal(runId);
};

export const getRun = async (runId: string) => {
  const db = getDb();
  return db.query.videoRuns.findFirst({ where: eq(videoRuns.id, runId) });
};

export const listRuns = async () => {
  const db = getDb();
  return db.select().from(videoRuns).orderBy(desc(videoRuns.createdAt)).limit(50);
};

export const getRunUsageSummary = async (runId: string) => {
  const db = getDb();
  const rows = await db.select().from(providerUsage).where(eq(providerUsage.runId, runId));
  return {
    attempts: rows.length,
    failedAttempts: rows.filter((row) => row.outcome === "failed").length,
    unpricedAttempts: rows.filter((row) => row.costMicrounits === null).length,
    inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    cachedInputTokens: rows.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    reasoningTokens: rows.reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0),
    inputCharacters: rows.reduce((sum, row) => sum + (row.inputCharacters ?? 0), 0),
    costMicrounits: rows.length && rows.every((row) => row.costMicrounits !== null) ? rows.reduce((sum, row) => sum + (row.costMicrounits ?? 0), 0) : null,
    byStage: rows.map((row) => ({ stage: row.stage, provider: row.provider, model: row.model, outcome: row.outcome, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens, costMicrounits: row.costMicrounits, contextManifest: row.contextManifest })),
  };
};

export const durationBand = (seconds: number) => seconds <= 60 ? "15-60" : seconds <= 180 ? "61-180" : "181-900";

/** Cost baseline from the first 20 accepted videos is required before alerting. */
export const COST_BASELINE_MIN_SAMPLE = 20;
export const COST_REVIEW_MULTIPLIER = 1.25;

export const percentile75 = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)] ?? 0;
};

/** The p75 over comparable accepted videos above which a run is reviewed. */
export const costReviewThreshold = (baselineCosts: number[]) => percentile75(baselineCosts) * COST_REVIEW_MULTIPLIER;

/** Emits a non-blocking review event after a comparable accepted baseline exists. */
export const evaluateCostReviewAlert = async (runId: string) => {
  const db = getDb();
  const current = await getRun(runId);
  if (!current || current.status !== "completed") return false;
  const completed = await db.select({ id: videoRuns.id, domain: videoRuns.domain, snapshot: videoRuns.snapshot }).from(videoRuns).where(eq(videoRuns.status, "completed"));
  if (completed.length < 21) return false;
  const usageRows = await db.select({ runId: providerUsage.runId, model: providerUsage.model, cost: providerUsage.costMicrounits }).from(providerUsage).where(inArray(providerUsage.runId, completed.map((run) => run.id)));
  const byRun = new Map<string, { cost: number; models: Set<string>; unpriced: boolean }>();
  for (const row of usageRows) {
    const currentUsage = byRun.get(row.runId) ?? { cost: 0, models: new Set<string>(), unpriced: false };
    currentUsage.cost += row.cost ?? 0;
    currentUsage.unpriced ||= row.cost === null;
    currentUsage.models.add(row.model);
    byRun.set(row.runId, currentUsage);
  }
  const currentUsage = byRun.get(runId);
  if (!currentUsage || currentUsage.unpriced) return false;
  const routeKey = (models: Set<string>) => [...models].sort().join(",");
  const cohortKey = (run: { domain: string; snapshot: InputSnapshot }, models: Set<string>) => `${run.domain}:${durationBand(run.snapshot.durationSeconds)}:${routeKey(models)}`;
  const comparableIds = completed.filter((run) => run.id !== runId && byRun.has(run.id) && cohortKey(run, byRun.get(run.id)!.models) === cohortKey(current, currentUsage.models)).map((run) => run.id);
  const cohortCosts = comparableIds.map((id) => byRun.get(id)).filter((usage): usage is { cost: number; models: Set<string>; unpriced: false } => usage !== undefined && !usage.unpriced).map((usage) => usage.cost);
  const baselineCosts = cohortCosts.length >= 5 ? cohortCosts : completed.filter((run) => run.id !== runId).map((run) => byRun.get(run.id)).filter((usage): usage is { cost: number; models: Set<string>; unpriced: false } => usage !== undefined && !usage.unpriced).map((usage) => usage.cost);
  if (baselineCosts.length < 5) return false;
  const p75 = percentile75(baselineCosts);
  if (currentUsage.cost <= costReviewThreshold(baselineCosts)) return false;
  await appendRunEvent(runId, null, "status", "Cost review alert: accepted-video cost exceeds the comparable baseline p75 by more than 25%.", { costMicrounits: currentUsage.cost, baselineP75Microunits: p75, cohort: cohortKey(current, currentUsage.models), sampleSize: baselineCosts.length, blocking: false });
  return true;
};

export const getRunEvents = async (runId: string, afterSequence = 0) => {
  const db = getDb();
  return db.select().from(runEvents).where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence))).orderBy(asc(runEvents.sequence));
};

export const setRunStatus = async (runId: string, status: RunStatus, updates: { stage?: StageName | null; failureCode?: string; failureMessage?: string } = {}) => {
  const db = getDb();
  await db.update(videoRuns).set({
    status,
    currentStage: updates.stage,
    failureCode: updates.failureCode,
    failureMessage: updates.failureMessage,
    updatedAt: new Date(),
    completedAt: status === "completed" ? new Date() : null,
  }).where(eq(videoRuns.id, runId));
};

export const STAGE_LEASE_MS = 5 * 60 * 1_000;
/**
 * A worker must renew its lease well before expiry.  Keeping this independent
 * of the queue acknowledgement is important: BullMQ delivery is not durable
 * ownership of a pipeline stage.
 */
export const STAGE_LEASE_HEARTBEAT_MS = Math.floor(STAGE_LEASE_MS / 3);

export class StageLeaseLostError extends Error {
  constructor(runId: string, stage: StageName) {
    super(`Stage lease is no longer owned: ${runId}/${stage}`);
    this.name = "StageLeaseLostError";
  }
}

/** Claims one stage attempt in PostgreSQL; queue delivery is not ownership. */
export const claimStageLease = async (params: { runId: string; stage: StageName; inputHash: string; owner: string; now?: Date }): Promise<{ leaseToken: string; leaseExpiresAt: Date; attemptCount: number } | null> => {
  const db = getDb();
  const now = params.now ?? new Date();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + STAGE_LEASE_MS);
  const current = await db.query.stageCheckpoints.findFirst({ where: and(eq(stageCheckpoints.runId, params.runId), eq(stageCheckpoints.stage, params.stage)) });

  if (!current) {
    const inserted = await db.insert(stageCheckpoints).values({
      runId: params.runId, stage: params.stage, inputHash: params.inputHash, outcome: "running",
      leaseToken, leaseOwner: params.owner, leaseHeartbeatAt: now, leaseExpiresAt, attemptCount: 1,
    }).onConflictDoNothing().returning({ id: stageCheckpoints.id });
    if (!inserted.length) return claimStageLease(params);
    return { leaseToken, leaseExpiresAt, attemptCount: 1 };
  }

  if ((current.outcome === "valid" || current.outcome === "awaiting_approval") && current.inputHash === params.inputHash) return null;
  if (current.leaseExpiresAt && current.leaseExpiresAt > now && current.outcome === "running") return null;
  const claimed = await db.update(stageCheckpoints).set({
    inputHash: params.inputHash, outcome: "running", leaseToken, leaseOwner: params.owner,
    leaseHeartbeatAt: now, leaseExpiresAt, attemptCount: sql`${stageCheckpoints.attemptCount} + 1`, updatedAt: now,
  }).where(and(
    eq(stageCheckpoints.id, current.id),
    or(eq(stageCheckpoints.outcome, "valid"), eq(stageCheckpoints.outcome, "failed"), eq(stageCheckpoints.outcome, "awaiting_approval"), isNull(stageCheckpoints.leaseExpiresAt), lt(stageCheckpoints.leaseExpiresAt, now)),
  )).returning({ id: stageCheckpoints.id });
  return claimed.length ? { leaseToken, leaseExpiresAt, attemptCount: current.attemptCount + 1 } : null;
};

export const heartbeatStageLease = async (params: { runId: string; stage: StageName; leaseToken: string; owner: string; now?: Date }) => {
  const db = getDb();
  const now = params.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + STAGE_LEASE_MS);
  const updated = await db.update(stageCheckpoints).set({ leaseOwner: params.owner, leaseHeartbeatAt: now, leaseExpiresAt, updatedAt: now }).where(and(
    eq(stageCheckpoints.runId, params.runId), eq(stageCheckpoints.stage, params.stage), eq(stageCheckpoints.leaseToken, params.leaseToken), eq(stageCheckpoints.outcome, "running"),
  )).returning({ id: stageCheckpoints.id });
  if (!updated.length) throw new StageLeaseLostError(params.runId, params.stage);
  return leaseExpiresAt;
};

/**
 * Renews a claimed stage while provider calls or rendering are in progress.
 * Callers must await `stop()` before committing their checkpoint; that makes
 * a lease loss a hard fence instead of silently promoting stale work.
 */
export const startStageLeaseHeartbeat = (params: {
  runId: string;
  stage: StageName;
  leaseToken: string;
  owner: string;
  intervalMs?: number;
}) => {
  let stopped = false;
  let lost: StageLeaseLostError | null = null;
  let pending: Promise<void> | null = null;
  const intervalMs = params.intervalMs ?? STAGE_LEASE_HEARTBEAT_MS;

  const renew = () => {
    if (stopped || pending || lost) return;
    pending = heartbeatStageLease(params)
      .then(() => undefined)
      .catch((error: unknown) => {
        lost = error instanceof StageLeaseLostError
          ? error
          : new StageLeaseLostError(params.runId, params.stage);
      })
      .finally(() => { pending = null; });
  };

  const timer = setInterval(renew, intervalMs);
  // A lease timer must never be the only reason a worker process stays alive.
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (lost) throw lost;
    },
  };
};

export const checkpointStage = async (params: { runId: string; stage: StageName; inputHash: string; outcome: "valid" | "failed" | "awaiting_approval"; outputHash?: string; evidence?: Record<string, unknown>; modelRoute?: ModelRoute; leaseToken?: string; leaseOwner?: string }) => {
  const db = getDb();
  const now = new Date();
  const where = [eq(stageCheckpoints.runId, params.runId), eq(stageCheckpoints.stage, params.stage)];
  if (params.leaseToken) where.push(eq(stageCheckpoints.leaseToken, params.leaseToken));
  const updated = await db.update(stageCheckpoints).set({
    inputHash: params.inputHash, outputHash: params.outputHash, outcome: params.outcome,
    evidence: params.evidence ?? {}, leaseToken: null, leaseOwner: params.leaseOwner ?? null,
    ...(params.modelRoute ? { modelRoute: params.modelRoute } : {}),
    leaseHeartbeatAt: now, leaseExpiresAt: null, updatedAt: now,
  }).where(and(...where)).returning({ id: stageCheckpoints.id });
  if (updated.length) return;
  // A caller that supplied a lease has lost ownership.  It must never create
  // a second checkpoint or promote output after a newer worker took the lease.
  if (params.leaseToken) throw new StageLeaseLostError(params.runId, params.stage);
  await db.insert(stageCheckpoints).values({
    runId: params.runId, stage: params.stage, inputHash: params.inputHash, outputHash: params.outputHash,
    outcome: params.outcome, evidence: params.evidence ?? {}, attemptCount: 1, leaseOwner: params.leaseOwner,
    ...(params.modelRoute ? { modelRoute: params.modelRoute } : {}),
  }).onConflictDoNothing();
};
