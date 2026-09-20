import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { artifacts, artifactAttempts, closeDb, getDb, mediaAssets, outbox, sourceDocuments, stageCheckpoints, videoRuns, viewerOutcomes } from "../src/index.ts";
import { checkpointStage, claimStageLease, heartbeatStageLease, STAGE_LEASE_MS, StageLeaseLostError } from "../../pipeline/src/runs.ts";
import { decideInvalidArtifactRetry, getStageInputHash, recordInvalidArtifactAttempt, resolveStageRoute, validationFeedback } from "../../pipeline/src/stages.ts";
import { collectRegressionFixtures } from "../../pipeline/src/feedback-regression.ts";
import { closeQueue } from "../../pipeline/src/queue.ts";
import { recoverReservedRuns } from "../../pipeline/src/outbox.ts";

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

  it("recovers a run that crashed mid-stage instead of leaving it running forever", async () => {
    const db = getDb();
    const crashRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: crashRunId, status: "running", domain: "standard", currentStage: "research",
      title: "Crash mid-stage fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Crash mid-stage fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "7".repeat(64),
    });
    const claimed = await claimStageLease({ runId: crashRunId, stage: "research", inputHash: "8".repeat(64), owner: "crashed-worker" });
    expect(claimed).not.toBeNull();
    await db.update(stageCheckpoints).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(stageCheckpoints.runId, crashRunId));

    await recoverReservedRuns();

    const checkpoint = await db.query.stageCheckpoints.findFirst({ where: eq(stageCheckpoints.runId, crashRunId) });
    expect(checkpoint?.outcome).toBe("failed");
    expect(checkpoint?.evidence).toMatchObject({ recoveryReason: "expired_stage_lease" });
    const dispatches = await db.select().from(outbox).where(eq(outbox.key, `${crashRunId}--research--recovery-2`));
    expect(dispatches.length).toBe(1);
    await db.delete(videoRuns).where(eq(videoRuns.id, crashRunId));
  });

  it("persists invalid-artifact attempts and feeds the validation error into the bounded regeneration", async () => {
    const db = getDb();
    const retryRunId = randomUUID();
    const inputHash = "a".repeat(64);
    await db.insert(videoRuns).values({
      id: retryRunId, status: "running", domain: "standard", currentStage: "blueprint",
      title: "Invalid artifact regeneration fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Invalid artifact regeneration fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "b".repeat(64),
    });

    const firstDecision = decideInvalidArtifactRetry({ attemptCount: 1, error: new SyntaxError("malformed JSON") });
    expect(firstDecision).toMatchObject({ regenerate: true, nextAttempt: 2 });
    await recordInvalidArtifactAttempt({ runId: retryRunId, stage: "blueprint", inputHash, error: new SyntaxError("malformed JSON"), attempt: 1 });
    await recordInvalidArtifactAttempt({ runId: retryRunId, stage: "blueprint", inputHash, error: new SyntaxError("malformed JSON again"), attempt: 2 });

    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, retryRunId));
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.status === "invalid" && row.role === "blueprint-attempt")).toBe(true);
    expect(rows.map((row) => row.version).sort()).toEqual([1, 2]);
    const attempts = await db.select().from(artifactAttempts).where(eq(artifactAttempts.artifactId, rows[0]!.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("invalid");
    expect(attempts[0]!.errorCode).toBe("ARTIFACT_VALIDATION");

    const feedback = await validationFeedback(retryRunId, "blueprint");
    expect(feedback).toContain("bounded artifact attempts failed validation");
    expect(feedback).toContain("malformed JSON");
    await db.delete(videoRuns).where(eq(videoRuns.id, retryRunId));
  });

  it("does not regenerate past the attempt budget", async () => {
    const db = getDb();
    const budgetRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: budgetRunId, status: "running", domain: "standard", currentStage: "blueprint",
      title: "Attempt budget fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Attempt budget fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "c".repeat(64),
    });
    await recordInvalidArtifactAttempt({ runId: budgetRunId, stage: "blueprint", inputHash: "d".repeat(64), error: new SyntaxError("malformed JSON"), attempt: 3 });
    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, budgetRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("invalid");
    expect(decideInvalidArtifactRetry({ attemptCount: 3, error: new SyntaxError("malformed JSON") })).toEqual({ regenerate: false, reason: "attempt_budget_exhausted" });
    await db.delete(videoRuns).where(eq(videoRuns.id, budgetRunId));
  });

  it("persists the resolved model route on the checkpoint and replays it with the locked route", async () => {
    const db = getDb();
    const routeRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: routeRunId, status: "running", domain: "standard", currentStage: "research",
      title: "Checkpoint model route fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Checkpoint model route fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "e".repeat(64),
    });
    const route = resolveStageRoute("research")!;
    const lease = await claimStageLease({ runId: routeRunId, stage: "research", inputHash: "f".repeat(64), owner: "route-worker" });
    expect(lease).not.toBeNull();
    await checkpointStage({ runId: routeRunId, stage: "research", inputHash: "f".repeat(64), outputHash: "1".repeat(64), outcome: "valid", leaseToken: lease!.leaseToken, modelRoute: route });

    const persisted = await db.query.stageCheckpoints.findFirst({ where: eq(stageCheckpoints.runId, routeRunId) });
    expect(persisted?.modelRoute).toMatchObject({ capability: "planning", provider: "openai", configVersion: "model-config/v1" });

    // A later env change must not rewrite the frozen route already recorded.
    process.env.OPENAI_PLANNING_MODEL = "gpt-5.6-sol";
    const stillFrozen = await db.query.stageCheckpoints.findFirst({ where: eq(stageCheckpoints.runId, routeRunId) });
    expect(stillFrozen?.modelRoute?.model).toBe(route.model);
    delete process.env.OPENAI_PLANNING_MODEL;
    await db.delete(videoRuns).where(eq(videoRuns.id, routeRunId));
  });

  it("turns persisted weak viewer outcomes into regression fixtures", async () => {
    const db = getDb();
    const feedbackRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: feedbackRunId, status: "completed", domain: "standard", title: "Feedback regression fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Feedback regression fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "f".repeat(64),
    });
    await db.insert(viewerOutcomes).values([
      { runId: feedbackRunId, kind: "retention", metric: "intro-retention", value: 400_000, recordedBy: "viewer" },
      { runId: feedbackRunId, kind: "scene-drop", segment: "scene-2", metric: "drop-at-2s", value: 450_000, recordedBy: "viewer" },
      { runId: feedbackRunId, kind: "rewatch", metric: "rewatch-count", value: 3_000_000, recordedBy: "viewer" },
    ]);
    const fixtures = await collectRegressionFixtures();
    const forRun = fixtures.filter((fixture) => fixture.runId === feedbackRunId);
    expect(forRun.map((fixture) => fixture.metric).sort()).toEqual(["drop-at-2s", "intro-retention"]);
    expect(forRun.every((fixture) => fixture.schemaVersion === "regression-fixture/v1")).toBe(true);
    await db.delete(videoRuns).where(eq(videoRuns.id, feedbackRunId));
  });

  it("marks a stage-less running run visibly failed during recovery", async () => {
    const db = getDb();
    const orphanRunId = randomUUID();
    await db.insert(videoRuns).values({
      id: orphanRunId, status: "running", domain: "standard", currentStage: null,
      title: "Orphan running fixture",
      snapshot: {
        schemaVersion: "input-snapshot/v1", topic: "Orphan running fixture", learningLevel: "Grade 8",
        audienceCategory: "school", language: "en", durationSeconds: 60, aspectRatio: "16:9",
        domain: "standard", visualProfile: "test", requestedDestination: "local", sourceIds: [],
      },
      snapshotHash: "9".repeat(64),
    });

    await recoverReservedRuns();

    const recovered = await db.query.videoRuns.findFirst({ where: eq(videoRuns.id, orphanRunId) });
    expect(recovered?.status).toBe("failed");
    expect(recovered?.failureCode).toBe("RECOVERY_WITHOUT_STAGE");
    await db.delete(videoRuns).where(eq(videoRuns.id, orphanRunId));
  });
});

afterAll(async () => {
  const db = getDb();
  await db.delete(videoRuns).where(eq(videoRuns.id, runId));
  await closeQueue();
  await closeDb();
});
