import { and, eq } from "drizzle-orm";
import {
  approvals,
  artifacts,
  getDb,
  intakeAttempts,
  intakeSessions,
  providerUsage,
  renderOutputs,
  sourceClaims,
  sourceDocuments,
  stageCheckpoints,
} from "@upcraft/db";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { failWithFindings } from "../../usage.ts";
import { evaluateCostReviewAlert, getRun, setRunStatus } from "../../runs.ts";
import { validateClientStyleApproval } from "../../domain-qa.ts";
import type { StageContext } from "../context.ts";

/**
 * §12 M11 Release record — the immutable `release-record/v1` assembled from every
 * locked artifact, checkpoint, usage record, approval, and render output. A run
 * cannot complete without the final render, manifest, QA report, and an approved
 * decision. Client-production rights/style policy is checked here.
 */
export const runReleaseRecord = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const db = getDb();
  const [run, outputArtifact, manifestArtifact, qaArtifact, sources, claims, artifactRows, checkpoints, usage, approvalRows, renders, intake] = await Promise.all([
    getRun(runId), ctx.getArtifact(runId, "final-render"), ctx.getArtifact(runId, "project-manifest"), ctx.getArtifact(runId, "qa-report"),
    db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId)), db.select().from(sourceClaims).where(eq(sourceClaims.runId, runId)),
    db.select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.status, "valid"))), db.select().from(stageCheckpoints).where(eq(stageCheckpoints.runId, runId)),
    db.select().from(providerUsage).where(eq(providerUsage.runId, runId)), db.select().from(approvals).where(eq(approvals.runId, runId)), db.select().from(renderOutputs).where(eq(renderOutputs.runId, runId)),
    db.query.intakeSessions.findFirst({ where: eq(intakeSessions.videoRunId, runId) }),
  ]);
  const output = requireContent(outputArtifact, "final-render");
  if (!run || !manifestArtifact || !qaArtifact || !approvalRows.some((approval) => approval.decision === "approved")) throw new Error("Release record prerequisites are incomplete");
  const clientStyleIssues = validateClientStyleApproval({ domain: run.domain, approvals: approvalRows.map((approval) => ({ decision: approval.decision, notes: approval.notes })) });
  if (clientStyleIssues.length) await failWithFindings(runId, "Client production policy", clientStyleIssues);
  const intakeAttemptsRows = intake ? await db.select().from(intakeAttempts).where(eq(intakeAttempts.sessionId, intake.id)) : [];
  const recordContent = { schemaVersion: "release-record/v1", releasedAt: new Date().toISOString(), run: { id: run.id, title: run.title, domain: run.domain, snapshot: run.snapshot, snapshotHash: run.snapshotHash }, intake: intake ? { sessionId: intake.id, inputHash: intake.inputHash, brief: intake.brief, briefHash: intake.briefHash, attempts: intakeAttemptsRows.map((attempt) => ({ attempt: attempt.attempt, provider: attempt.provider, model: attempt.model, requestId: attempt.requestId, promptVersion: attempt.promptVersion, outcome: attempt.outcome, inputTokens: attempt.inputTokens, cachedInputTokens: attempt.cachedInputTokens, outputTokens: attempt.outputTokens, reasoningTokens: attempt.reasoningTokens, latencyMs: attempt.latencyMs, contextManifest: attempt.contextManifest })) } : null, finalOutput: output, manifest: manifestArtifact.content, qa: qaArtifact.content, sources: sources.map((source) => ({ id: source.id, name: source.originalName, url: source.sourceUrl, sha256: source.sha256, sourceBytesSha256: source.sourceBytesSha256, retrievedAt: source.retrievedAt?.toISOString() ?? null })), claims: claims.map((claim) => ({ id: claim.id, sourceId: claim.sourceId, claim: claim.claim, locator: claim.locator, evidence: claim.evidence, critical: claim.critical, verifiedAt: claim.verifiedAt?.toISOString() ?? null, verifierModel: claim.verifierModel })), artifacts: artifactRows.map((artifact) => ({ id: artifact.id, stage: artifact.stage, role: artifact.role, version: artifact.version, sha256: artifact.sha256, inputHash: artifact.inputHash, schemaVersion: artifact.schemaVersion, provenance: artifact.provenance })), checkpoints: checkpoints.map((checkpoint) => ({ stage: checkpoint.stage, inputHash: checkpoint.inputHash, outputHash: checkpoint.outputHash, outcome: checkpoint.outcome, evidence: checkpoint.evidence, modelRoute: checkpoint.modelRoute ?? null })), providerUsage: usage.map((entry) => ({ stage: entry.stage, provider: entry.provider, model: entry.model, requestId: entry.requestId, outcome: entry.outcome, latencyMs: entry.latencyMs, inputTokens: entry.inputTokens, cachedInputTokens: entry.cachedInputTokens, outputTokens: entry.outputTokens, reasoningTokens: entry.reasoningTokens, inputCharacters: entry.inputCharacters, outputCharacters: entry.outputCharacters, costMicrounits: entry.costMicrounits, pricingVersion: entry.pricingVersion, promptVersion: entry.promptVersion, contextManifest: entry.contextManifest })), approvals: approvalRows.map((approval) => ({ decision: approval.decision, reviewerId: approval.reviewerId, clinicianApproverId: approval.clinicianApproverId, notes: approval.notes })), renders: renders.map((renderOutput) => ({ kind: renderOutput.kind, sha256: renderOutput.sha256, durationMs: renderOutput.durationMs, width: renderOutput.width, height: renderOutput.height })) };
  const record = await saveArtifact({ runId, stage: "release-record", role: "release-record", schemaVersion: "release-record/v1", inputHash: sha(recordContent), content: recordContent });
  await setRunStatus(runId, "completed", { stage: "release-record" });
  await evaluateCostReviewAlert(runId);
  return record;
};