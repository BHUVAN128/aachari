import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, stageCheckpoints, videoRuns } from "../src/index.ts";
import { claimStageLease, STAGE_LEASE_MS } from "../../pipeline/src/runs.ts";

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
});

afterAll(async () => {
  const db = getDb();
  await db.delete(videoRuns).where(eq(videoRuns.id, runId));
  await closeDb();
});
