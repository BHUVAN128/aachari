import { asc, eq } from "drizzle-orm";
import { getDb, sourceDocuments } from "@upcraft/db";
import type { StageName } from "@upcraft/contracts";
import { getRun } from "../runs.ts";
import { getArtifact } from "../artifacts/store.ts";
import { sha } from "../artifacts/hashing.ts";
import { stageInputRoles } from "./registry.ts";

/**
 * Hashes the locked rows actually consumed by a stage, never only the run ID.
 *
 * The input-role table lives in `registry.ts` beside the dependency graph it
 * belongs to; this function reads it so the two can never drift apart.
 */
export const getStageInputHash = async (runId: string, stage: StageName) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const roles = stageInputRoles[stage] ?? [];
  const lockedArtifacts = [];
  for (const role of roles) {
    const artifact = await getArtifact(runId, role);
    lockedArtifacts.push({ role, id: artifact?.id ?? null, sha256: artifact?.sha256 ?? null, inputHash: artifact?.inputHash ?? null, schemaVersion: artifact?.schemaVersion ?? null });
  }
  const sources = await getDb().select({ id: sourceDocuments.id, sha256: sourceDocuments.sha256, sourceBytesSha256: sourceDocuments.sourceBytesSha256, retrievedAt: sourceDocuments.retrievedAt }).from(sourceDocuments).where(eq(sourceDocuments.runId, runId)).orderBy(asc(sourceDocuments.id));
  return sha({ snapshotHash: run.snapshotHash, stage, artifacts: lockedArtifacts, sources });
};