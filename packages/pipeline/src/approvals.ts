import { approvals, getDb } from "@upcraft/db";
import { eq } from "drizzle-orm";
import { appendRunEvent, getRun, setRunStatus } from "./runs.ts";
import { scheduleStage } from "./outbox.ts";

/**
 * Pure approval policy. Approval is uniform across all domains: a run in
 * `awaiting_approval` is approved by an identified reviewer.
 */
export const assertApprovalPolicy = (
  run: { status: string; domain: string },
  _approval: { reviewerId: string },
) => {
  if (run.status !== "awaiting_approval") throw new Error("Run is not awaiting approval");
};

export const approveRun = async (runId: string, approval: { reviewerId: string }) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  assertApprovalPolicy(run, approval);
  const db = getDb();
  await db.insert(approvals).values({
    runId,
    decision: "approved",
    reviewerId: approval.reviewerId,
  });
  await setRunStatus(runId, "running", { stage: "final-render" });
  await appendRunEvent(runId, "approval", "approval", "Run approved for final render.", { reviewerId: approval.reviewerId });
  await scheduleStage(runId, "final-render");
};
