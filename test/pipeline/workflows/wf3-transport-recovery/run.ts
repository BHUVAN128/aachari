import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, providerUsage } from "@upcraft/db";
import { resolveModelRoute } from "@upcraft/providers";
import { createVideoRun } from "@upcraft/pipeline";
import { saveArtifact, withFallback } from "@upcraft/pipeline/stages";
import { prepareHarness, resetHarness } from "../../setup/stage-context.ts";
import { buildRunInput } from "../../setup/inputs.ts";
import { fetchWithTimeout, startFlakyServer, withTransportRetry, TRANSPORT_TRUNCATED, type RetryAttempt } from "../../steps/s02-research/transport-hardening.ts";

/**
 * WF3 — transport recovery. Uses a local flaky HTTP server to exercise the real
 * fetch path, the real `withFallback` route policy, and the real idempotent
 * artifact store. No provider credential is required.
 */
const run = async () => {
  // --- cut stream → TRANSPORT_TRUNCATED → success on retry ---
  const truncating = await startFlakyServer({ failFirst: 1, body: JSON.stringify({ ok: true, payload: "y".repeat(256) }) });
  try {
    const attempts: RetryAttempt[] = [];
    const value = await withTransportRetry({
      maxAttempts: 3,
      attempt: async () => (await fetchWithTimeout(truncating.url, { timeoutMs: 5_000 })).json() as Promise<{ ok: boolean }>,
      onAttempt: (record) => {
        attempts.push(record);
      },
    });
    assert.equal(value.ok, true);
    assert.deepEqual(attempts.map((entry) => entry.outcome), ["transport-truncated", "completed"]);
    assert.equal(attempts[0]!.errorCode, TRANSPORT_TRUNCATED);
    console.log(`WF3 truncation: ${attempts.map((entry) => entry.outcome).join(" → ")}`);
  } finally {
    await truncating.close();
  }

  // --- hang → timeout → fallback route ---
  const hanging = await startFlakyServer({ hangFirst: 3 });
  try {
    const route = resolveModelRoute("planning");
    const used: string[] = [];
    const fallback = await withFallback(
      route,
      async (attemptRoute) => {
        used.push(attemptRoute.model);
        if (attemptRoute.model === route.model) {
          await fetchWithTimeout(hanging.url, { timeoutMs: 150 });
        }
        return { ok: true };
      },
      async () => undefined,
    );
    assert.deepEqual(used, [route.model, "gpt-5.6-sol"]);
    assert.equal(fallback.route.resolvedFrom, "fallback");
    console.log(`WF3 hang → fallback route: ${used.join(" → ")}`);
  } finally {
    await hanging.close();
  }

  // --- crash before checkpoint → idempotent replay, no double payment ---
  await prepareHarness();
  const runId = await createVideoRun(await buildRunInput("photosynthesis"));
  const db = getDb();
  const before = (await db.select().from(providerUsage).where(eq(providerUsage.runId, runId))).length;
  const content = { assetId: "11111111-1111-4111-8111-111111111111", objectKey: "runs/fake/narration.mp3", words: [{ text: "hello", startMs: 0, endMs: 500 }] };
  const first = await saveArtifact({ runId, stage: "voiceover", role: "voiceover", schemaVersion: "voiceover/v1", inputHash: "locked-input-hash", content });
  const replay = await saveArtifact({ runId, stage: "voiceover", role: "voiceover", schemaVersion: "voiceover/v1", inputHash: "locked-input-hash", content });
  assert.equal(replay.id, first.id, "replay with the same locked input must return the existing artifact");
  assert.equal(replay.version, first.version, "replay must not create a new version");
  const after = (await db.select().from(providerUsage).where(eq(providerUsage.runId, runId))).length;
  assert.equal(after, before, "replay must not record new provider usage");
  console.log("WF3 resume: idempotent replay returned the existing artifact with no new provider usage");
  console.log("WF3 PASS");
  await resetHarness();
  process.exit(0);
};

run().catch((error) => {
  console.error("WF3 FAIL:", error);
  process.exit(1);
});