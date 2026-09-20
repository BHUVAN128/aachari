import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { artifacts, getDb, sourceDocuments, videoRuns } from "@upcraft/db";

/**
 * Frozen-upstream support for correct-then-combine.
 *
 * Once a step is green its artifact is written to `test/pipeline/artifacts/<runId>/`.
 * A later step's test hydrates those frozen artifacts into the new run instead of
 * re-running (and re-paying for) the upstream stage. `FROZEN.json` is the pointer
 * map from artifact role to the green source stage; it is advanced only when a
 * step's checkboxes are ticked in `STATUS.md`.
 */

const ARTIFACTS_ROOT = fileURLToPath(new URL("../artifacts", import.meta.url));
const FROZEN_POINTER = join(ARTIFACTS_ROOT, "FROZEN.json");

export type FrozenPointer = Record<string, { runId: string; stage: string }>;

const readPointer = async (): Promise<FrozenPointer> => {
  try {
    return JSON.parse(await readFile(FROZEN_POINTER, "utf8")) as FrozenPointer;
  } catch {
    return {};
  }
};

const writePointer = async (pointer: FrozenPointer) => {
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  await writeFile(FROZEN_POINTER, JSON.stringify(pointer, null, 2), "utf8");
};

/** Records that a step's artifact is frozen and available to downstream tests. */
export const freezeStageArtifact = async (runId: string, stage: string, roles: string[]) => {
  const pointer = await readPointer();
  for (const role of roles) pointer[role] = { runId, stage };
  await writePointer(pointer);
};

const readFrozenArtifact = async (role: string, pointer: FrozenPointer) => {
  const entry = pointer[role];
  if (!entry) return undefined;
  const dir = join(ARTIFACTS_ROOT, entry.runId);
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as { role?: string; schemaVersion?: string; sha256?: string; content?: Record<string, unknown> };
    if (parsed.role === role && parsed.content) return parsed;
  }
  return undefined;
};

/**
 * Copies frozen upstream artifacts into `runId`. The run must already exist so the
 * foreign key holds; the caller normally creates it from the same mock input.
 */
export const hydrateFrozenUpstream = async (runId: string, roles?: string[]) => {
  const pointer = await readPointer();
  const wanted = (roles ?? Object.keys(pointer)).filter((role) => pointer[role]);
  const db = getDb();
  for (const role of wanted) {
    const frozen = await readFrozenArtifact(role, pointer);
    if (!frozen?.content) continue;
    const entry = pointer[role]!;
    const existing = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.runId, runId));
    if (existing.length) {
      const already = await db.select({ id: artifacts.id, role: artifacts.role }).from(artifacts).where(eq(artifacts.runId, runId));
      if (already.some((row) => row.role === role)) continue;
    }
    await db.insert(artifacts).values({
      runId,
      stage: entry.stage as never,
      role,
      version: 1,
      status: "valid",
      schemaVersion: frozen.schemaVersion ?? `${role}/frozen`,
      content: frozen.content,
      sha256: frozen.sha256 ?? null,
      inputHash: `frozen:${entry.runId}:${role}`,
      provenance: { provider: "deterministic", model: "frozen-upstream/v1", frozenFrom: entry.runId },
      validatedAt: new Date(),
    });
  }
};

/**
 * Seeds the source documents and run row for a step whose upstream research stage
 * is frozen. The frozen `source-evidence-map` already references source ids, so a
 * fresh run needs matching `source_documents` rows for the foreign-key links.
 */
const hydrateFrozenSources = async (runId: string, fromRunId: string) => {
  const db = getDb();
  const rows = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, fromRunId));
  if (!rows.length) return;
  const existing = await db.select({ id: sourceDocuments.id }).from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  if (existing.length) return;
  await db.insert(sourceDocuments).values(rows.map((row) => ({
    id: row.id, runId, kind: row.kind, originalName: row.originalName, objectKey: row.objectKey, sourceUrl: row.sourceUrl,
    retrievedUrl: row.retrievedUrl, retrievalStatus: row.retrievalStatus, sourceByteSize: row.sourceByteSize, sha256: row.sha256,
    sourceBytesSha256: row.sourceBytesSha256, mimeType: row.mimeType, extractedText: row.extractedText, retrievedAt: row.retrievedAt,
  })));
};

/** Convenience: create a fresh run row that reuses an existing run's snapshot/sources. */
export const createFrozenRun = async (fromRunId: string, newRunId: string) => {
  const db = getDb();
  const [source] = await db.select().from(videoRuns).where(eq(videoRuns.id, fromRunId));
  if (!source) throw new Error(`Frozen run ${fromRunId} not found`);
  await db.insert(videoRuns).values({
    id: newRunId, status: "queued", domain: source.domain, currentStage: null, title: source.title,
    snapshot: source.snapshot, snapshotHash: source.snapshotHash, rendererVersion: null, failureCode: null, failureMessage: null,
  });
  await hydrateFrozenSources(newRunId, fromRunId);
  return newRunId;
};