import { desc, eq } from "drizzle-orm";
import { getDb, videoRuns, viewerOutcomes } from "@upcraft/db";
import { ViewerOutcomeInputSchema, type ViewerOutcomeInput } from "@upcraft/contracts";

/**
 * Viewer-outcome feedback closes the release loop: retention, scene drops,
 * rewatches, quiz results, and teacher/reviewer feedback are stored against the
 * immutable run so weak scenes can become new regression examples.
 */
export const toMillionths = (value: number) => Math.round(value * 1_000_000);
export const fromMillionths = (value: number) => value / 1_000_000;

export const recordViewerOutcome = async (runId: string, rawInput: ViewerOutcomeInput, recordedBy: string) => {
  const input = ViewerOutcomeInputSchema.parse(rawInput);
  const db = getDb();
  const run = await db.query.videoRuns.findFirst({ where: eq(videoRuns.id, runId) });
  if (!run) throw new Error("Run not found");
  if (run.status !== "completed") throw new Error("Viewer outcomes may only be recorded for a completed video");
  const [row] = await db.insert(viewerOutcomes).values({
    runId, kind: input.kind, segment: input.segment, metric: input.metric,
    value: toMillionths(input.value), unit: input.unit, detail: input.detail, recordedBy,
  }).returning();
  return row;
};

export const listViewerOutcomes = async (runId: string) => {
  const db = getDb();
  return db.select().from(viewerOutcomes).where(eq(viewerOutcomes.runId, runId)).orderBy(desc(viewerOutcomes.createdAt));
};
