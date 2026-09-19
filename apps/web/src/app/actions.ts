"use server";

import { redirect } from "next/navigation";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { CreateRunInputSchema } from "@upcraft/contracts";
import { clinicianApprovers, getDb } from "@upcraft/db";
import { approveRun, createVideoRun } from "@upcraft/pipeline";

export type FormState = { error?: string };

export const createRunAction = async (_previous: FormState, formData: FormData): Promise<FormState> => {
  try {
    const sourceValue = String(formData.get("sourceValue") ?? "").trim();
    const input = CreateRunInputSchema.parse({
      topic: formData.get("topic"), learningLevel: formData.get("learningLevel"), audienceCategory: formData.get("audienceCategory") || "school", language: formData.get("language") || "en",
      durationSeconds: Number(formData.get("durationSeconds")), aspectRatio: formData.get("aspectRatio") || "16:9", domain: formData.get("domain"),
      visualProfile: formData.get("visualProfile"), requestedDestination: "local",
      sources: [{ kind: formData.get("sourceKind") === "url" ? "url" : "text", name: String(formData.get("sourceName") || "Primary source"), value: sourceValue }],
    });
    const runId = await createVideoRun(input);
    redirect(`/runs/${runId}`);
  } catch (error) {
    unstable_rethrow(error);
    return { error: error instanceof Error ? error.message : "Unable to create run." };
  }
};

export const approveRunAction = async (runId: string, domain: string) => {
  let reviewerId = "local-operator";
  let clinicianApproverId: string | undefined;
  if (domain === "medical") {
    const { userId } = await auth();
    if (!userId) throw new Error("A Clerk-authenticated clinician is required to approve medical content.");
    const clinician = await getDb().query.clinicianApprovers.findFirst({ where: eq(clinicianApprovers.clerkUserId, userId) });
    if (!clinician?.active) throw new Error("The signed-in account is not an approved clinician.");
    reviewerId = clinician.id;
    clinicianApproverId = clinician.id;
  }
  await approveRun(runId, clinicianApproverId ? { reviewerId, clinicianApproverId } : { reviewerId });
};
