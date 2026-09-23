import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb, providerUsage, sourceDocuments } from "@upcraft/db";
import type { CreateRunInput, ModelRoute } from "@upcraft/contracts";
import { assertCapabilities } from "@upcraft/providers";
import { appendRunEvent, createVideoRun, getRun, setRunStatus } from "@upcraft/pipeline";
import { buildRunInput, type HarnessInputName } from "./inputs.ts";
import { artifactFor, runStage } from "./runner.ts";
import { prepareHarness } from "./stage-context.ts";
import { logDirFor, ndjsonPathFor, sessionLogPathFor } from "./logger.ts";
import { loadRepoEnv } from "./load-env.ts";
import { screenSources, type SourceClassifier } from "./preflight-hardening/screening.ts";
import { decidePrivacyGate, mergePrivacyScans, scanForPii } from "./preflight-hardening/privacy.ts";
import { validateSourceProvenance, type ProvenanceSourceInput } from "./preflight-hardening/provenance.ts";
import { assertRunIdentityUnique, estimateRunCostCeiling } from "./preflight-hardening/fraud-controls.ts";
import { buildComplianceReport, type ComplianceReport } from "./preflight-hardening/compliance-report.ts";

/**
 * s01 Preflight hardening — harness runner.
 *
 * Mirrors `intake-runner.ts`: it runs the real production `runPreflight` through
 * the existing `runStage()` + `processPipelineStage()` path, then applies the
 * sandbox hardening modules to the frozen snapshot and persists a
 * `compliance-report/v1` evidence artifact.
 *
 * Order matters. The zero-token compliance gate runs first, on the frozen
 * snapshot, before capability preflight and long before s02 schedules any
 * billable call. A blocked gate sets a terminal run failure and returns; a passed
 * gate proceeds to the real capability/storage preflight, which is visible
 * BLOCKED (never a fabricated pass) when its credentials are absent.
 *
 * The source classifier is injectable and defaults to the deterministic denylist
 * only, so harness tests never send source bytes to a provider.
 */

const ARTIFACTS_ROOT = fileURLToPath(new URL("../artifacts", import.meta.url));

export const complianceReportPathFor = (runId: string) => join(ARTIFACTS_ROOT, runId, "preflight-compliance.json");

export type PreflightHarnessResult = {
  runId: string;
  status: "passed" | "blocked" | "failed";
  compliance: ComplianceReport;
  capabilityOutcome: "valid" | "blocked" | "failed" | "skipped";
  blockReason?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Provider attempts recorded for the run; the compliance path must be zero. */
  productCalls: number;
  capabilityReport?: Record<string, unknown> | null;
};

const countUsage = async (runId: string) => (await getDb().select({ id: providerUsage.id }).from(providerUsage).where(eq(providerUsage.runId, runId))).length;

export const runPreflightHarness = async (params: {
  input?: HarnessInputName;
  /** A custom frozen input (used by the hostile fixture); wins over `input`. */
  runInput?: CreateRunInput;
  /** Use an existing run instead of creating one. */
  runId?: string;
  /** Injectable model classifier; omit for the deterministic offline path. */
  classifier?: SourceClassifier;
  /** Override resolved routes for a reproducible cost ceiling. */
  routes?: readonly ModelRoute[];
}): Promise<PreflightHarnessResult> => {
  loadRepoEnv();
  await prepareHarness();

  const runId = params.runId ?? (await createVideoRun(params.runInput ?? (await buildRunInput(params.input ?? "photosynthesis"))));
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const sourceRows = await getDb().select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));

  const screeningInputs = sourceRows.map((source) => ({
    id: source.id,
    text: source.extractedText ?? source.sourceUrl ?? "",
    contentHash: source.sha256,
  }));
  const screening = await screenSources({ sources: screeningInputs, ...(params.classifier ? { classify: params.classifier } : {}) });

  const privacyScan = mergePrivacyScans(screeningInputs.map((source) => scanForPii(source.text)));
  const privacy = decidePrivacyGate(privacyScan);

  const provenanceInputs: ProvenanceSourceInput[] = sourceRows.map((source) => ({
    id: source.id,
    kind: source.kind,
    name: source.originalName,
    value: source.sourceUrl ?? source.extractedText ?? "",
    hash: source.sha256,
  }));
  const provenance = validateSourceProvenance(provenanceInputs);

  const idempotency = await assertRunIdentityUnique(runId);
  const costCeiling = estimateRunCostCeiling(run.snapshot, { sourceCount: sourceRows.length, ...(params.routes ? { routes: params.routes } : {}) });

  const compliance = buildComplianceReport({
    snapshotHash: run.snapshotHash,
    sourceCount: sourceRows.length,
    screening,
    privacyScan,
    privacy,
    provenance,
    costCeiling,
    idempotency,
  });

  await mkdir(logDirFor(runId), { recursive: true });
  const reportPath = complianceReportPathFor(runId);
  await mkdir(join(ARTIFACTS_ROOT, runId), { recursive: true });
  await writeFile(reportPath, JSON.stringify(compliance, null, 2), "utf8");
  await appendFile(ndjsonPathFor(runId, "preflight-compliance"), `${JSON.stringify(compliance)}\n`, "utf8");
  const log = (message: string) => appendFile(sessionLogPathFor(runId), `${new Date().toISOString()} [s01-preflight] ${message}\n`, "utf8");
  await log(`compliance decision=${compliance.decision}${compliance.failureCode ? ` failureCode=${compliance.failureCode}` : ""} sources=${sourceRows.length} cost=${compliance.costCeiling.totalMicrounits ?? "unpriced"} duplicate=${compliance.idempotency.duplicateRunId ?? "none"}`);

  // A blocked gate is terminal: no capability preflight, no s02, no billable call.
  if (compliance.decision === "blocked") {
    const failureCode = compliance.failureCode ?? "safety_policy_rejected";
    const failureMessage = `Preflight compliance gate blocked the run: ${failureCode}`;
    await setRunStatus(runId, "failed", { stage: "preflight", failureCode, failureMessage });
    await appendRunEvent(runId, "preflight", "stage_failed", failureMessage, { failureCode, terminal: true });
    await log(`BLOCKED terminal failureCode=${failureCode}`);
    return { runId, status: "blocked", compliance, capabilityOutcome: "skipped", failureCode, failureMessage, productCalls: await countUsage(runId) };
  }

  // Compliance passed. Now the real production capability/storage preflight.
  try {
    assertCapabilities(run.domain, { sourceCount: sourceRows.length });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "capability preflight is unavailable";
    await log(`BLOCKED (credential) ${reason}`);
    return { runId, status: "blocked", compliance, capabilityOutcome: "blocked", blockReason: reason, productCalls: await countUsage(runId) };
  }

  const result = await runStage({ stage: "preflight", input: params.input ?? "photosynthesis", runId, allowBlocked: true });
  const capabilityReport = (await artifactFor(runId, "capability-report"))?.content ?? null;
  const productCalls = await countUsage(runId);
  if (result.checkpointOutcome === "valid") {
    await log(`capability preflight valid, compliance pass, providerCalls=${productCalls}`);
    return { runId, status: "passed", compliance, capabilityOutcome: "valid", productCalls, capabilityReport };
  }
  if (result.checkpointOutcome === "failed") {
    return { runId, status: "failed", compliance, capabilityOutcome: "failed", failureCode: result.failureCode ?? "STAGE_FAILED", failureMessage: result.failureMessage ?? "capability preflight failed", productCalls, capabilityReport };
  }
  return { runId, status: "blocked", compliance, capabilityOutcome: "blocked", ...(result.blockReason ? { blockReason: result.blockReason } : {}), productCalls, capabilityReport };
};
