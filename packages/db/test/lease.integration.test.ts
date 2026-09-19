import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { artifacts, closeDb, getDb, mediaAssets, sourceDocuments, stageCheckpoints, videoRuns } from "../src/index.ts";
import { checkpointStage, claimStageLease, heartbeatStageLease, STAGE_LEASE_MS, StageLeaseLostError } from "../../pipeline/src/runs.ts";
import { getStageInputHash } from "../../pipeline/src/stages.ts";

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

  it("uses locked source and artifact rows in checkpoint identities", async () => {
    const db = getDb();
    const hashRunId = randomUUID();
    const sourceId = randomUUID();
    await db.insert(videoRuns).values({
      id: hashRunId, status: "queued", domain: "standard", title: "Checkpoint input hash fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Checkpoint input hash fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [sourceId],
      },
      snapshotHash: "e".repeat(64),
    });
    await db.insert(sourceDocuments).values({
      id: sourceId, runId: hashRunId, kind: "text", originalName: "Evidence", extractedText: "Locked source text.",
      sha256: "f".repeat(64), sourceBytesSha256: "f".repeat(64), mimeType: "text/plain", retrievedAt: new Date(),
    });
    const researchBefore = await getStageInputHash(hashRunId, "research");
    await db.update(sourceDocuments).set({ sha256: "1".repeat(64) }).where(eq(sourceDocuments.id, sourceId));
    expect(await getStageInputHash(hashRunId, "research")).not.toBe(researchBefore);

    const [factPack] = await db.insert(artifacts).values({
      runId: hashRunId, stage: "research", role: "fact-pack", version: 1, status: "valid", schemaVersion: "fact-pack/v2",
      content: { schemaVersion: "fact-pack/v2", claims: [], caveats: [] }, sha256: "2".repeat(64), inputHash: "3".repeat(64), validatedAt: new Date(),
    }).returning({ id: artifacts.id });
    const blueprintBefore = await getStageInputHash(hashRunId, "blueprint");
    await db.update(artifacts).set({ sha256: "4".repeat(64) }).where(eq(artifacts.id, factPack!.id));
    expect(await getStageInputHash(hashRunId, "blueprint")).not.toBe(blueprintBefore);
    await db.delete(videoRuns).where(eq(videoRuns.id, hashRunId));
  });

  it("does not duplicate a media asset on replay", async () => {
    const db = getDb();
    const mediaRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: mediaRunId, status: "queued", domain: "standard", title: "Media replay fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Media replay fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "5".repeat(64),
    });
    const value = { runId: mediaRunId, role: "diagram-replay", objectKey: "runs/test/diagram.svg", sha256: "6".repeat(64), mimeType: "image/svg+xml", byteSize: 12, selected: true };
    await db.insert(mediaAssets).values(value).returning({ id: mediaAssets.id });
    const replay = await db.insert(mediaAssets).values({ ...value, objectKey: "runs/test/duplicate.svg" }).onConflictDoNothing().returning({ id: mediaAssets.id });
    expect(replay).toEqual([]);
    expect((await db.select().from(mediaAssets).where(eq(mediaAssets.runId, mediaRunId))).length).toBe(1);
    await db.delete(videoRuns).where(eq(videoRuns.id, mediaRunId));
  });
});

afterAll(async () => {
  const db = getDb();
  await db.delete(videoRuns).where(eq(videoRuns.id, runId));
  await closeDb();
});
