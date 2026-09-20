import { and, desc, eq, inArray, max } from "drizzle-orm";
import { artifacts, artifactAttempts, getDb } from "@upcraft/db";
import type { StageName } from "@upcraft/contracts";
import { stageRoute, routeProvenance } from "../routing.ts";
import { sha } from "./hashing.ts";

type Json = Record<string, unknown>;

/**
 * Durable artifact store. Every stage reads and writes versioned typed artifacts
 * through this module, so there is exactly one idempotency/versioning
 * implementation behind the reliability contract's "durable video run" rule.
 *
 * Pure extraction from `stages.ts`; behavior is unchanged.
 */
export const getArtifact = async (runId: string, role: string) => {
  const db = getDb();
  return db.query.artifacts.findFirst({
    where: and(eq(artifacts.runId, runId), eq(artifacts.role, role), eq(artifacts.status, "valid")),
    orderBy: [desc(artifacts.version), desc(artifacts.createdAt)],
  });
};

export const saveArtifact = async (params: { runId: string; stage: StageName; role: string; schemaVersion: string; content: Json; inputHash: string; provenance?: Json }) => {
  const db = getDb();
  const existing = await getArtifact(params.runId, params.role);
  if (existing?.inputHash === params.inputHash) return existing;
  const version = existing ? existing.version + 1 : 1;
  const route = stageRoute(params.stage);
  const provenance = routeProvenance(route);
  const [artifact] = await db.insert(artifacts).values({
    runId: params.runId, stage: params.stage, role: params.role, version, status: "valid",
    schemaVersion: params.schemaVersion, content: params.content, inputHash: params.inputHash,
    sha256: sha(params.content), provenance: { ...provenance, ...(params.provenance ?? {}) }, validatedAt: new Date(),
  }).returning();
  if (!artifact) throw new Error("Artifact persistence failed");
  if (existing) await db.update(artifacts).set({ status: "superseded" }).where(eq(artifacts.id, existing.id));
  await db.insert(artifactAttempts).values({ artifactId: artifact.id, attempt: 1, inputHash: params.inputHash, outputHash: artifact.sha256 ?? undefined, schemaVersion: params.schemaVersion, provider: route?.provider ?? "deterministic", model: route?.model ?? "repository-code", promptVersion: `${params.stage}/v1`, outcome: "validated", validationEvidence: { schemaVersion: params.schemaVersion } });
  return artifact;
};

export const recordInvalidArtifactAttempt = async (params: { runId: string; stage: StageName; inputHash: string; error: unknown; attempt: number }) => {
  const db = getDb();
  const role = `${params.stage}-attempt`;
  const existing = await db.select({ version: max(artifacts.version) }).from(artifacts).where(and(eq(artifacts.runId, params.runId), eq(artifacts.stage, params.stage), eq(artifacts.role, role)));
  const version = (existing[0]?.version ?? 0) + 1;
  const message = params.error instanceof Error ? params.error.message.slice(0, 1_000) : "Artifact validation failed.";
  const [artifact] = await db.insert(artifacts).values({
    runId: params.runId, stage: params.stage, role, version, status: "invalid", schemaVersion: `${params.stage}/attempt`, inputHash: params.inputHash,
    provenance: { failure: "artifact-validation", attempt: params.attempt },
  }).returning({ id: artifacts.id });
  if (!artifact) return;
  await db.insert(artifactAttempts).values({
    artifactId: artifact.id, attempt: params.attempt, inputHash: params.inputHash, schemaVersion: `${params.stage}/attempt`,
    provider: stageRoute(params.stage)?.provider ?? "deterministic", model: stageRoute(params.stage)?.model ?? "repository-code", promptVersion: `${params.stage}/v1`, outcome: "invalid",
    errorCode: "ARTIFACT_VALIDATION", errorMessage: message, validationEvidence: { message, retryable: params.attempt < 3 },
  });
};

export const validationFeedback = async (runId: string, stage: StageName) => {
  const db = getDb();
  const invalids = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.stage, stage), eq(artifacts.status, "invalid")));
  if (!invalids.length) return "";
  const attempts = await db.select({ errorMessage: artifactAttempts.errorMessage, validationEvidence: artifactAttempts.validationEvidence }).from(artifactAttempts).where(inArray(artifactAttempts.artifactId, invalids.map((artifact) => artifact.id))).orderBy(desc(artifactAttempts.createdAt)).limit(3);
  if (!attempts.length) return "";
  return `Previous bounded artifact attempts failed validation. Correct these transport/schema defects without inventing content:\n${attempts.map((attempt) => `- ${attempt.errorMessage ?? JSON.stringify(attempt.validationEvidence)}`).join("\n")}\n`;
};

export const requireContent = <T extends Json>(artifact: { content: Json | null } | undefined, role: string) => {
  if (!artifact?.content) throw new Error(`Required valid artifact missing: ${role}`);
  return artifact.content as T;
};

/**
 * A manifest layer that names a selected asset which is not available at render
 * time must block the render; a placeholder would silently ship a broken visual.
 */
export const missingRenderAssets = (
  layers: Array<{ id: string; assetId?: string | undefined }>,
  availableAssetIds: Iterable<string>,
) => {
  const available = new Set(availableAssetIds);
  return layers.filter((layer) => layer.assetId && !available.has(layer.assetId));
};