import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { getDb, providerUsage } from "@upcraft/db";

/**
 * Local logging system for the step harness.
 *
 * The harness must never write to production telemetry, but the records it emits
 * must be directly comparable to the real `provider_usage` row so that a promoted
 * fix is an apples-to-apples change. Every entry is therefore derived from the
 * harness database's real `provider_usage` rows (the same table and columns the
 * production ledger uses) and additionally carries the harness-only fields the
 * step contracts assert on (attempt index, verifier outcome, artifact hash,
 * checkpoint outcome).
 *
 * Layout:
 *   test/pipeline/logs/<runId>/<step>.ndjson   one JSON object per line
 *   test/pipeline/logs/<runId>/session.log     human-readable tail
 */

export type UsageOutcome =
  | "completed"
  | "failed"
  | "rejected-by-verifier"
  | "transport-truncated"
  | "validation-failed";

export type CheckpointOutcome = "valid" | "failed" | "awaiting_approval" | "skipped" | "blocked";

export type UsageLogEntry = {
  ts: string;
  runId: string;
  stage: string;
  attempt: number;
  capability: string | null;
  provider: string;
  model: string;
  modelRef: string;
  promptVersion: string;
  projection: string;
  contextManifest: {
    projection: string;
    hash: string;
    chars: number;
    itemCount: number;
  };
  inputCharacters: number | null;
  outputCharacters: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  outcome: string;
  errorCode: string | null;
  validationError: string | null;
  artifactSchemaVersion: string | null;
  artifactSha256: string | null;
  checkpointOutcome: CheckpointOutcome;
};

export type StepSummary = {
  stage: string;
  runId: string;
  outcomes: string[];
  attempts: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicrounits: number | null;
  artifactRole: string | null;
  artifactSha256: string | null;
  checkpointOutcome: CheckpointOutcome;
};

const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOGS_ROOT = join(HARNESS_ROOT, "logs");

export const logDirFor = (runId: string) => join(LOGS_ROOT, runId);
export const ndjsonPathFor = (runId: string, stage: string) => join(logDirFor(runId), `${stage}.ndjson`);
export const sessionLogPathFor = (runId: string) => join(logDirFor(runId), "session.log");

const projectionFrom = (manifest: Record<string, unknown> | null, fallback: string) => {
  const projection = manifest?.projection;
  return typeof projection === "string" ? projection : fallback;
};

const contextCharsFrom = (manifest: Record<string, unknown> | null) => {
  const total = manifest?.totalChars;
  return typeof total === "number" ? total : 0;
};

const contextItemCountFrom = (manifest: Record<string, unknown> | null) => {
  const inputs = manifest?.inputs;
  if (!Array.isArray(inputs)) return 0;
  return inputs.reduce((sum, input) => sum + (input && typeof input === "object" && typeof (input as { itemCount?: unknown }).itemCount === "number" ? ((input as { itemCount: number }).itemCount) : 0), 0);
};

export type Logger = {
  runId: string;
  stage: string;
  session: (message: string) => Promise<void>;
  capture: (params: {
    checkpointOutcome: CheckpointOutcome;
    artifactRole?: string | null;
    artifactSha256?: string | null;
    modelRef?: string | null;
    validationError?: string | null;
  }) => Promise<StepSummary>;
  readUsage: () => Promise<UsageLogEntry[]>;
};

export const createLogger = async (runId: string, stage: string): Promise<Logger> => {
  await mkdir(logDirFor(runId), { recursive: true });
  const ndjsonPath = ndjsonPathFor(runId, stage);
  const sessionPath = sessionLogPathFor(runId);

  const session = async (message: string) => {
    await appendFile(sessionPath, `${new Date().toISOString()} [${stage}] ${message}\n`, "utf8");
  };

  const readUsage = async (): Promise<UsageLogEntry[]> => {
    try {
      const raw = await readFile(ndjsonPath, "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as UsageLogEntry);
    } catch {
      return [];
    }
  };

  /**
   * Materializes the step's provider attempts from the real usage table. Rows are
   * written in `createdAt` order so the attempt sequence is deterministic.
   */
  const capture: Logger["capture"] = async (params) => {
    const rows = await getDb().select().from(providerUsage).where(and(eq(providerUsage.runId, runId), eq(providerUsage.stage, stage as never))).orderBy(asc(providerUsage.createdAt), asc(providerUsage.id));
    let cost = 0;
    let costPriced = rows.length > 0;
    const entries: UsageLogEntry[] = rows.map((row, index) => {
      if (row.costMicrounits === null) costPriced = false;
      else cost += row.costMicrounits;
      const manifest = (row.contextManifest ?? {}) as Record<string, unknown>;
      return {
        ts: row.createdAt.toISOString(),
        runId,
        stage,
        attempt: index + 1,
        capability: params.modelRef && params.modelRef !== row.model ? null : null,
        provider: row.provider,
        model: row.model,
        modelRef: params.modelRef ?? `${row.provider}/${row.model}`,
        promptVersion: row.promptVersion ?? `${stage}/v2`,
        projection: projectionFrom(manifest, "unknown"),
        contextManifest: {
          projection: projectionFrom(manifest, "unknown"),
          hash: typeof manifest.hash === "string" ? manifest.hash : "",
          chars: contextCharsFrom(manifest),
          itemCount: contextItemCountFrom(manifest),
        },
        inputCharacters: row.inputCharacters,
        outputCharacters: row.outputCharacters,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        latencyMs: row.latencyMs,
        outcome: row.outcome,
        errorCode: row.errorCode,
        validationError: params.validationError ?? null,
        artifactSchemaVersion: `${stage}/v2`,
        artifactSha256: params.artifactSha256 ?? null,
        checkpointOutcome: params.checkpointOutcome,
      };
    });
    if (entries.length) await appendFile(ndjsonPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    await session(`capture: ${entries.length} attempt(s), checkpoint=${params.checkpointOutcome}${params.artifactRole ? `, artifact=${params.artifactRole}` : ""}`);
    return {
      stage,
      runId,
      outcomes: entries.map((entry) => entry.outcome),
      attempts: entries.length,
      latencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0),
      inputTokens: entries.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
      outputTokens: entries.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
      costMicrounits: costPriced && entries.length ? cost : null,
      artifactRole: params.artifactRole ?? null,
      artifactSha256: params.artifactSha256 ?? entries.at(-1)?.artifactSha256 ?? null,
      checkpointOutcome: params.checkpointOutcome,
    };
  };

  return { runId, stage, session, capture, readUsage };
};

export const printSummary = (summary: StepSummary) => {
  const cost = summary.costMicrounits === null ? "unpriced" : `${summary.costMicrounits}µ$`;
  console.log(
    `\n[${summary.stage}] runId=${summary.runId}\n` +
      `  outcomes  : ${summary.outcomes.join(" → ") || "(none)"}\n` +
      `  attempts  : ${summary.attempts}\n` +
      `  latency   : ${summary.latencyMs}ms\n` +
      `  tokens    : ${summary.inputTokens} in / ${summary.outputTokens} out\n` +
      `  cost      : ${cost}\n` +
      `  artifact  : ${summary.artifactRole ?? "(none)"} ${summary.artifactSha256 ?? ""}\n` +
      `  checkpoint: ${summary.checkpointOutcome}`,
  );
};