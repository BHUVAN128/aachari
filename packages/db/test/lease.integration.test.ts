import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, stageCheckpoints, videoRuns } from "../src/index.ts";
import { checkpointStage, claimStageLease, heartbeatStageLease, STAGE_LEASE_MS, StageLeaseLostError } from "../../pipeline/src/runs.ts";

const runId = randomUUID();

describe("stage lease persistence", () => {
  it("allows one owner and reclaims an expired lease", async () => {
    const db = getDb();
    await db.insert(videoRuns).values({
      id: runId,
      status: "running",
      domain: "standard",
      currentStage: "research",
      title: "Lease integration fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1",
        topic: "Lease integration fixture",
        learningLevel: "Grade 8",
        audienceCategory: "school",
        language: "en",
        durationSeconds: 60,
        aspectRatio: "16:9",
        domain: "standard",
        visualProfile: "test",
        requestedDestination: "local",
        sourceIds: [],
      },
      snapshotHash: "a".repeat(64),
    });

    const first = await claimStageLease({ runId, stage: "research", inputHash: "b".repeat(64), owner: "integration-a" });
    expect(first).not.toBeNull();
    const second = await claimStageLease({ runId, stage: "research", inputHash: "b".repeat(64), owner: "integration-b" });
    expect(second).toBeNull();

    const expiredAt = new Date(Date.now() - STAGE_LEASE_MS - 1);
    await db.update(stageCheckpoints).set({ leaseExpiresAt: expiredAt }).where(eq(stageCheckpoints.runId, runId));
    const reclaimed = await claimStageLease({ runId, stage: "research", inputHash: "b".repeat(64), owner: "integration-b" });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.attemptCount).toBe(2);
  });

  it("renews an active lease and fences an owner after its lease is reclaimed", async () => {
    const db = getDb();
    const heartbeatRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: heartbeatRunId, status: "running", domain: "standard", currentStage: "research",
      title: "Lease heartbeat fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Lease heartbeat fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "c".repeat(64),
    });
    const first = await claimStageLease({ runId: heartbeatRunId, stage: "research", inputHash: "d".repeat(64), owner: "integration-a" });
    expect(first).not.toBeNull();
    const heartbeatAt = new Date(Date.now() + STAGE_LEASE_MS - 1);
    await heartbeatStageLease({ runId: heartbeatRunId, stage: "research", leaseToken: first!.leaseToken, owner: "integration-a", now: heartbeatAt });
    expect(await claimStageLease({ runId: heartbeatRunId, stage: "research", inputHash: "d".repeat(64), owner: "integration-b", now: new Date(heartbeatAt.getTime() + 1) })).toBeNull();

    await db.update(stageCheckpoints).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(stageCheckpoints.runId, heartbeatRunId));
    const reclaimed = await claimStageLease({ runId: heartbeatRunId, stage: "research", inputHash: "d".repeat(64), owner: "integration-b" });
    expect(reclaimed).not.toBeNull();
    await expect(checkpointStage({ runId: heartbeatRunId, stage: "research", inputHash: "d".repeat(64), outcome: "valid", leaseToken: first!.leaseToken })).rejects.toBeInstanceOf(StageLeaseLostError);
    const checkpoint = await db.query.stageCheckpoints.findFirst({ where: eq(stageCheckpoints.runId, heartbeatRunId) });
    expect(checkpoint?.outcome).toBe("running");
    expect(checkpoint?.leaseToken).toBe(reclaimed!.leaseToken);
    await db.delete(videoRuns).where(eq(videoRuns.id, heartbeatRunId));
  });
});

afterAll(async () => {
  const db = getDb();
  await db.delete(videoRuns).where(eq(videoRuns.id, runId));
  await closeDb();
});
