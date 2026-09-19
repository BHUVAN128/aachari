import { approvals, clinicianApprovers, getDb } from "@upcraft/db";
import { and, eq } from "drizzle-orm";
import { appendRunEvent, getRun, setRunStatus } from "./runs.ts";
import { scheduleStage } from "./outbox.ts";

export const approveRun = async (runId: string, approval: { reviewerId: string; clinicianApproverId?: string }) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  if (run.status !== "awaiting_approval") throw new Error("Run is not awaiting approval");
  if (run.domain === "medical" && !approval.clinicianApproverId) throw new Error("Medical runs require an identified clinician approver.");
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
