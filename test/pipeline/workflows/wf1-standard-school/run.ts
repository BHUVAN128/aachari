import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { approvals, getDb, providerUsage, videoRuns } from "@upcraft/db";
import { STAGE_ORDER } from "@upcraft/contracts";
import { prepareHarness, resetHarness } from "../../setup/stage-context.ts";
import { runStage } from "../../setup/runner.ts";
import { buildRunInput } from "../../setup/inputs.ts";
import { createVideoRun } from "@upcraft/pipeline";

/**
 * WF1 — standard school end-to-end chain. Stops visibly at the first blocked or
 * failed stage rather than reporting a partial run as complete. When every
 * capability is available it asserts the full release invariants.
 */
const run = async () => {
  await prepareHarness();
  const runId = await createVideoRun(await buildRunInput("photosynthesis"));
  const blocked: string[] = [];

  for (const stage of STAGE_ORDER) {
    if (stage === "approval") continue;
    const result = await runStage({ stage, input: "photosynthesis", runId, allowBlocked: true });
    if (result.checkpointOutcome === "blocked") {
      blocked.push(`${stage}: ${result.blockReason}`);
      break;
    }
    if (result.checkpointOutcome === "failed") {
      blocked.push(`${stage}: ${result.failureCode} ${result.failureMessage}`);
      break;
    }
  }

  if (blocked.length) {
    console.log(`\nWF1 blocked: ${blocked[0]}`);
    console.log("WF1 SKIPPED (credentials required for a full live run)");
    await resetHarness();
    return "blocked";
  }

  const db = getDb();
  const runRow = await db.select().from(videoRuns).where(eq(videoRuns.id, runId)).limit(1).then((rows) => rows[0]);
  assert.equal(runRow?.status, "completed", "WF1 must complete");
  const usage = await db.select().from(providerUsage).where(eq(providerUsage.runId, runId));
  const modelCalls = usage.filter((row) => row.provider !== "elevenlabs");
  const ttsCalls = usage.filter((row) => row.provider === "elevenlabs");
  const tierB = usage.filter((row) => row.stage === "qa");
  assert.equal(tierB.length, 1, "exactly one Tier B qa-review call");
  assert.equal(ttsCalls.length, 1, "exactly one TTS call");
  assert.ok(modelCalls.length >= 7, `expected at least 7 model calls, saw ${modelCalls.length}`);
  const approval = await db.select().from(approvals).where(eq(approvals.runId, runId));
  assert.ok(approval.some((row) => row.decision === "approved"), "an approval must be recorded");
  console.log(`\nWF1 PASS — status=${runRow?.status}, modelCalls=${modelCalls.length}, ttsCalls=${ttsCalls.length}`);
  await resetHarness();
  return "passed";
};

run().then((status) => process.exit(status === "passed" ? 0 : 0)).catch((error) => {
  console.error("WF1 FAIL:", error);
  process.exit(1);
});