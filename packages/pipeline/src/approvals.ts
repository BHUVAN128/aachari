import { approvals, clinicianApprovers, getDb } from "@upcraft/db";
import { and, eq } from "drizzle-orm";
import { appendRunEvent, getRun, setRunStatus } from "./runs.ts";
import { scheduleStage } from "./outbox.ts";

/**
 * Pure approval policy. Medical content may never be published by an
 * automated or unidentified approver; this is the programmatic enforcement of
 * the clinician-approval requirement.
 */
export const assertApprovalPolicy = (
  run: { status: string; domain: string },
  approval: { clinicianApproverId?: string },
) => {
  if (run.status !== "awaiting_approval") throw new Error("Run is not awaiting approval");
  if (run.domain === "medical" && !approval.clinicianApproverId) throw new Error("Medical runs require an identified clinician approver.");
};

export const approveRun = async (runId: string, approval: { reviewerId: string; clinicianApproverId?: string }) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  assertApprovalPolicy(run, approval);
  const db = getDb();
  if (run.domain === "medical") {
    const clinician = await db.query.clinicianApprovers.findFirst({ where: and(eq(clinicianApprovers.id, approval.clinicianApproverId!), eq(clinicianApprovers.active, true)) });
    if (!clinician) throw new Error("Medical runs require an active approved clinician.");
  }
  await db.insert(approvals).values({
    runId,
    decision: "approved",
    reviewerId: approval.reviewerId,
    ...(approval.clinicianApproverId ? { clinicianApproverId: approval.clinicianApproverId } : {}),
  });
  await setRunStatus(runId, "running", { stage: "final-render" });
  await appendRunEvent(runId, "approval", "approval", "Run approved for final render.", { reviewerId: approval.reviewerId, clinicianApproverId: approval.clinicianApproverId ?? null });
  await scheduleStage(runId, "final-render");
};
