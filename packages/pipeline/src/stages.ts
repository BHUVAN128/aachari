import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, inArray, like, max } from "drizzle-orm";
import { ZodError } from "zod";
import {
  ApprovedScriptSchema,
  BlueprintSchema,
  BlueprintV2Schema,
  ClaimVerificationSchema,
  DiagramModelSchema,
  ConsolidatedReviewSchema,
  FactPackSchema,
  ProjectManifestSchema,
  ResolvedLayoutSchema,
  ScriptVerificationSchema,
  SourceEvidenceMapSchema,
  VisualBibleSchema,
  STAGE_ORDER,
  type StageName,
  type WordTiming,
} from "@upcraft/contracts";
import {
  artifacts,
  artifactAttempts,
  approvals,
  assetAnchors,
  getDb,
  intakeAttempts,
  intakeSessions,
  mediaAssets,
  providerUsage,
  qaFindings,
  renderOutputs,
  sourceClaims,
  sourceDocuments,
  stageCheckpoints,
  videoRuns,
} from "@upcraft/db";
import {
  assertCapabilities,
  assertStorageAvailable,
  generateIllustration,
  generateStructuredText,
  getPrivateObject,
  getPrivateReadUrl,
  putPrivateObject,
  resolveCapabilities,
  synthesizeNarration,
  verifyClaims,
  ProviderError,
  type ProviderUsageSnapshot,
} from "@upcraft/providers";
import { deriveFrameCount, probeAudioDurationMs, probeMedia, rendererVersion, renderLesson, type MediaProbe } from "@upcraft/compositor";
import { appendRunEvent, claimStageLease, checkpointStage, evaluateCostReviewAlert, getRun, setRunStatus, StageLeaseLostError, startStageLeaseHeartbeat } from "./runs.ts";
import { scheduleStage } from "./outbox.ts";
import { assertTelemetrySafe } from "./telemetry.ts";
import { assertHttpsRedirect, isSupportedSourceContentType, parseHttpsUrl } from "./source-url.ts";
import { assertClaimVerificationComplete, assertScriptVerificationComplete } from "./verification.ts";
import { buildSceneAssetBrief, buildSceneAssetBriefs, buildSceneDirections, buildScenePlans, buildSoundPlan } from "./planning.ts";
import { validateBlueprint } from "./blueprint-qa.ts";
import { renderAndValidateDiagram, type DiagramPalette } from "./diagram-qa.ts";
import { imageDimensions, validateIllustrationCandidate, validateRenderIntegrity, validateVoiceAlignment } from "./media-qa.ts";
import { validateClientStyleApproval } from "./domain-qa.ts";
import { audioRenderQa, consolidatedReviewQa, convergeQaTiers, deterministicQa, spatialQa, structuralQa, visualQa, type QaTierResult } from "./qa-branches.ts";
import { buildSourceEvidenceMap, canonicalNarrationText, contextManifest, projectFactVerificationContext, projectScriptContext, projectVisualContext, sourceEvidenceSegments } from "./context.ts";

type Json = Record<string, unknown>;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textSha = (value: string) => createHash("sha256").update(value).digest("hex");
const factPackJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["fact-pack/v2"] }, claims: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] }, critical: { type: "boolean" } }, required: ["id", "text", "evidence", "critical"] } }, caveats: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] } }, required: ["text"] } } }, required: ["schemaVersion", "claims", "caveats"] } as Record<string, unknown>;
const blueprintJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["lesson-blueprint/v2"] }, objective: { type: "string" }, prerequisites: { type: "array", minItems: 1, items: { type: "string" } }, hook: { type: "string" }, recap: { type: "string" }, knowledgeCheck: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } }, answerIndex: { type: "integer", minimum: 0 } }, required: ["question", "options", "answerIndex"] }, scenes: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, order: { type: "integer" }, purpose: { type: "string" }, claimIds: { type: "array", minItems: 1, items: { type: "string" } }, visualBeat: { type: "string" } }, required: ["id", "order", "purpose", "claimIds", "visualBeat"] } } }, required: ["schemaVersion", "objective", "prerequisites", "hook", "recap", "scenes"] } as Record<string, unknown>;
const scriptJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["approved-script/v2"] }, narration: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, sceneId: { type: "string" }, text: { type: "string" }, claimIds: { type: "array", items: { type: "string" } }, visualAction: { type: "string" } }, required: ["id", "sceneId", "text", "claimIds", "visualAction"] } } }, required: ["schemaVersion", "narration"] } as Record<string, unknown>;
const scriptVerificationJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["script-verification/v2"] }, evidence: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { lineId: { type: "string" }, supported: { type: "boolean" }, unsupportedClaimIds: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["lineId", "supported", "unsupportedClaimIds", "rationale"] } }, notes: { type: "array", items: { type: "string" } } }, required: ["schemaVersion", "evidence", "notes"] } as Record<string, unknown>;
const visualBibleJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["visual-bible/v1"] }, canvasTexture: { type: "string" }, lineStyle: { type: "string" }, palette: { type: "array", minItems: 2, items: { type: "string" } }, typography: { type: "object", additionalProperties: false, properties: { heading: { type: "string" }, body: { type: "string" }, caption: { type: "string" } }, required: ["heading", "body", "caption"] }, captionSafeArea: { type: "object", additionalProperties: false, properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } }, required: ["top", "right", "bottom", "left"] }, persistentEntities: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, description: { type: "string" } }, required: ["id", "description"] } }, camera: { type: "object", additionalProperties: false, properties: { behavior: { type: "string" }, transitions: { type: "array", items: { type: "string" } } }, required: ["behavior", "transitions"] }, prohibitedVisualPatterns: { type: "array", items: { type: "string" } } }, required: ["schemaVersion", "canvasTexture", "lineStyle", "palette", "typography", "captionSafeArea", "persistentEntities", "camera", "prohibitedVisualPatterns"] } as Record<string, unknown>;
const routeForStage = (stage: StageName) => {
  if (["research", "blueprint", "script", "visual-bible"].includes(stage)) return { provider: "openai", model: process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra" };
  if (stage === "fact-verification") return { provider: "gemini", model: process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash" };
  if (stage === "voiceover") return { provider: "elevenlabs", model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2" };
  return { provider: "deterministic", model: "repository-code" };
};
export const MAX_ARTIFACT_ATTEMPTS = 3;
export const isArtifactValidationFailure = (error: unknown) => error instanceof ZodError || error instanceof SyntaxError;

/**
 * Bounded regeneration policy for invalid model artifacts. A validation failure
 * may be regenerated with the validation error appended, never promoted by
 * syntactic repair alone, and never beyond the attempt budget.
 */
export const decideInvalidArtifactRetry = (params: { attemptCount: number; error: unknown }) => {
  if (!isArtifactValidationFailure(params.error)) return { regenerate: false, reason: "not_an_artifact_validation_failure" } as const;
  if (params.attemptCount >= MAX_ARTIFACT_ATTEMPTS) return { regenerate: false, reason: "attempt_budget_exhausted" } as const;
  return { regenerate: true, nextAttempt: params.attemptCount + 1, reason: "regenerate_with_validation_error" } as const;
};
const resolveSourceText = async (source: { extractedText: string | null; sourceUrl: string | null }) => {
  if (source.extractedText) return { text: source.extractedText, retrievedUrl: source.sourceUrl, retrievalStatus: "provided", contentType: "text/plain", byteSize: Buffer.byteLength(source.extractedText, "utf8"), rawSha256: textSha(source.extractedText) };
  if (!source.sourceUrl) throw new Error("Source has no text or URL");
  const url = parseHttpsUrl(source.sourceUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!response.ok) throw new Error(`Source fetch failed (${response.status})`);
  const finalUrl = assertHttpsRedirect(response.url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!isSupportedSourceContentType(contentType)) throw new Error(`Unsupported source content type: ${contentType}`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 1_000_000) throw new Error("Source exceeds the 1 MB extraction limit");
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 3) throw new Error("Source contains no extractable text");
  return { text, retrievedUrl: finalUrl.toString(), retrievalStatus: "retrieved", contentType, byteSize: Buffer.byteLength(body, "utf8"), rawSha256: textSha(body) };
};

const nextStage = (stage: StageName): StageName | undefined => {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 ? STAGE_ORDER[index + 1] : undefined;
};

const getArtifact = async (runId: string, role: string) => {
  const db = getDb();
  return db.query.artifacts.findFirst({
    where: and(eq(artifacts.runId, runId), eq(artifacts.role, role), eq(artifacts.status, "valid")),
    orderBy: [desc(artifacts.version), desc(artifacts.createdAt)],
  });
};

const saveArtifact = async (params: { runId: string; stage: StageName; role: string; schemaVersion: string; content: Json; inputHash: string; provenance?: Json }) => {
  const db = getDb();
  const existing = await getArtifact(params.runId, params.role);
  if (existing?.inputHash === params.inputHash) return existing;
  const version = existing ? existing.version + 1 : 1;
  const route = routeForStage(params.stage);
  const [artifact] = await db.insert(artifacts).values({
    runId: params.runId, stage: params.stage, role: params.role, version, status: "valid",
    schemaVersion: params.schemaVersion, content: params.content, inputHash: params.inputHash,
    sha256: sha(params.content), provenance: { ...route, ...(params.provenance ?? {}) }, validatedAt: new Date(),
  }).returning();
  if (!artifact) throw new Error("Artifact persistence failed");
  if (existing) await db.update(artifacts).set({ status: "superseded" }).where(eq(artifacts.id, existing.id));
  await db.insert(artifactAttempts).values({ artifactId: artifact.id, attempt: 1, inputHash: params.inputHash, outputHash: artifact.sha256 ?? undefined, schemaVersion: params.schemaVersion, provider: route.provider, model: route.model, promptVersion: `${params.stage}/v1`, outcome: "validated", validationEvidence: { schemaVersion: params.schemaVersion } });
  return artifact;
};

const recordInvalidArtifactAttempt = async (params: { runId: string; stage: StageName; inputHash: string; error: unknown; attempt: number }) => {
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
    provider: routeForStage(params.stage).provider, model: routeForStage(params.stage).model, promptVersion: `${params.stage}/v1`, outcome: "invalid",
    errorCode: "ARTIFACT_VALIDATION", errorMessage: message, validationEvidence: { message, retryable: params.attempt < 3 },
  });
};

const validationFeedback = async (runId: string, stage: StageName) => {
  const db = getDb();
  const invalids = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.stage, stage), eq(artifacts.status, "invalid")));
  if (!invalids.length) return "";
  const attempts = await db.select({ errorMessage: artifactAttempts.errorMessage, validationEvidence: artifactAttempts.validationEvidence }).from(artifactAttempts).where(inArray(artifactAttempts.artifactId, invalids.map((artifact) => artifact.id))).orderBy(desc(artifactAttempts.createdAt)).limit(3);
  if (!attempts.length) return "";
  return `Previous bounded artifact attempts failed validation. Correct these transport/schema defects without inventing content:\n${attempts.map((attempt) => `- ${attempt.errorMessage ?? JSON.stringify(attempt.validationEvidence)}`).join("\n")}\n`;
};

const requireContent = <T extends Json>(artifact: { content: Json | null } | undefined, role: string) => {
  if (!artifact?.content) throw new Error(`Required valid artifact missing: ${role}`);
  return artifact.content as T;
};

const failWithFindings = async (runId: string, scope: string, findings: Array<{ rule: string; evidence: Record<string, unknown>; remediation: string }>): Promise<never> => {
  await getDb().insert(qaFindings).values(findings.map((finding) => ({ runId, rule: finding.rule, severity: "critical" as const, evidence: finding.evidence, remediation: finding.remediation })));
  throw new Error(`${scope} failed: ${findings.map((finding) => finding.rule).join(", ")}`);
};

const pricingVersion = "pricing/2026-09-17";
const estimateCostMicrounits = (provider: string, usage: ProviderUsageSnapshot) => {
  const rates: Record<string, { input: number; output: number }> = {
    openai: { input: 2, output: 12 },
    gemini: { input: 0.75, output: 3.75 },
  };
  const rate = rates[provider];
  if (provider === "elevenlabs") {
    const perThousandCharacters = Number(process.env.ELEVENLABS_COST_MICRODOLLARS_PER_1K_CHARS);
    if (!Number.isFinite(perThousandCharacters) || usage.inputCharacters === undefined) return undefined;
    return Math.ceil((usage.inputCharacters / 1_000) * perThousandCharacters);
  }
  if (!rate || usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return Math.round((usage.inputTokens ?? 0) * rate.input + (usage.outputTokens ?? 0) * rate.output);
};

const recordUsage = async (runId: string, stage: StageName, provider: string, fallbackModel: string, startedAt: number, usage: ProviderUsageSnapshot = {}, promptVersion = `${stage}/v2`, context = {}, outcome = "completed", errorCode?: string) => {
  await getDb().insert(providerUsage).values({
    runId, stage, provider, model: usage.model ?? fallbackModel, requestId: usage.requestId,
    outcome, errorCode, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens,
    inputCharacters: usage.inputCharacters, outputCharacters: usage.outputCharacters,
    costMicrounits: estimateCostMicrounits(provider, usage), pricingVersion,
    promptVersion, contextManifest: assertTelemetrySafe(context), latencyMs: Date.now() - startedAt,
  });
};

const runPreflight = async (runId: string) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  assertCapabilities(run.domain);
  await assertStorageAvailable();
  return saveArtifact({ runId, stage: "preflight", role: "capability-report", schemaVersion: "capability-report/v1", inputHash: sha(run.snapshot), content: { checkedAt: new Date().toISOString(), domain: run.domain, renderer: "@remotion/renderer" } });
};

const runResearch = async (runId: string) => {
  const db = getDb();
  const sources = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  if (!sources.length) throw new Error("Research requires at least one source document");
  await Promise.all(sources.map(async (source) => {
    const resolved = await resolveSourceText(source);
    await db.update(sourceDocuments).set({
      extractedText: source.extractedText ?? resolved.text,
      sha256: source.extractedText ? source.sha256 : textSha(resolved.text),
      sourceBytesSha256: source.extractedText ? source.sourceBytesSha256 : resolved.rawSha256,
      retrievedAt: new Date(),
      retrievedUrl: resolved.retrievedUrl,
      retrievalStatus: resolved.retrievalStatus,
      sourceByteSize: resolved.byteSize,
      mimeType: source.extractedText ? source.mimeType : resolved.contentType,
    }).where(eq(sourceDocuments.id, source.id));
  }));
  const lockedSources = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  const evidenceMap = buildSourceEvidenceMap(lockedSources);
  const evidenceMapArtifact = await saveArtifact({ runId, stage: "research", role: "source-evidence-map", schemaVersion: evidenceMap.schemaVersion, inputHash: sha(lockedSources.map((source) => source.sha256)), content: evidenceMap, provenance: { provider: "deterministic", model: "source-segmentation/v1" } });
  const sourceContext = evidenceMap.sources.map((source) => `SOURCE ${source.sourceId} HASH ${source.sourceHash}\n${source.segments.map((segment) => `SEGMENT ${segment.id} [${segment.startOffset}:${segment.endOffset}]\n${segment.text}`).join("\n")}`).join("\n\n");
  const startedAt = Date.now();
  const raw = await generateStructuredText<Json>({
    schemaName: "fact_pack",
    jsonSchema: factPackJsonSchema,
    prompt: `${await validationFeedback(runId, "research")}Create a source-grounded fact pack. Use only the supplied source segments. Return JSON with schemaVersion "fact-pack/v2", claims [{id, text, evidence {sourceId, sourceHash, segmentIds, locator}, critical}], and caveats [{text, evidence?}]. Every claim must cite one or more supplied segment IDs. Do not quote or reproduce source text in the output.\n\n${sourceContext}`,
  });
  await recordUsage(runId, "research", "openai", process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra", startedAt, raw.usage, "research/v2", contextManifest("source-full-segmented/v1", [{ role: "source-evidence-map", hash: evidenceMapArtifact.sha256 ?? sha(evidenceMap), chars: sourceContext.length, itemCount: evidenceMap.sources.reduce((sum, source) => sum + source.segments.length, 0) }]));
  const factPack = FactPackSchema.parse(raw.value);
  for (const claim of factPack.claims) sourceEvidenceSegments(evidenceMap, [claim.evidence]);
  for (const caveat of factPack.caveats) if (caveat.evidence) sourceEvidenceSegments(evidenceMap, [caveat.evidence]);
  return saveArtifact({ runId, stage: "research", role: "fact-pack", schemaVersion: factPack.schemaVersion, inputHash: sha(sources.map((source) => source.sha256)), content: factPack });
};

const runFactVerification = async (runId: string) => {
  const factPack = requireContent(await getArtifact(runId, "fact-pack"), "fact-pack");
  const evidenceMap = SourceEvidenceMapSchema.parse(requireContent(await getArtifact(runId, "source-evidence-map"), "source-evidence-map"));
  const startedAt = Date.now();
  const verificationContext = projectFactVerificationContext(FactPackSchema.parse(factPack), evidenceMap);
  const verificationResult = await verifyClaims(`Independently verify every claim against only its supplied source segments. Return schemaVersion "claim-verification/v2", one evidence item per claim with claimId, sourceId, segmentIds, supported, rationale, and notes. Do not add facts, use uncited sources, or reproduce source text.\n${JSON.stringify(verificationContext)}`);
  await recordUsage(runId, "fact-verification", "gemini", process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash", startedAt, verificationResult.usage, "fact-verification/v2", contextManifest("claim-local-evidence/v1", [{ role: "fact-verification-context", hash: sha(verificationContext), chars: JSON.stringify(verificationContext).length, itemCount: verificationContext.evidenceSegments.length }]));
  const verification = ClaimVerificationSchema.parse(verificationResult.value);
  const parsedFactPack = FactPackSchema.parse(factPack);
  assertClaimVerificationComplete(verification, parsedFactPack);
  for (const entry of verification.evidence) {
    const claim = parsedFactPack.claims.find((candidate) => candidate.id === entry.claimId)!;
    sourceEvidenceSegments(evidenceMap, [{ sourceId: entry.sourceId, sourceHash: claim.evidence.sourceHash, segmentIds: entry.segmentIds }]);
  }
  const claimRows = parsedFactPack.claims.map((claim) => ({ runId, sourceId: claim.evidence.sourceId, claim: claim.text, locator: claim.evidence.locator, evidence: claim.evidence, critical: claim.critical, verifiedAt: new Date(), verifierModel: process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash" }));
  if (claimRows.length && !(await getDb().select({ id: sourceClaims.id }).from(sourceClaims).where(eq(sourceClaims.runId, runId))).length) await getDb().insert(sourceClaims).values(claimRows);
  return saveArtifact({ runId, stage: "fact-verification", role: "fact-verification", schemaVersion: "fact-verification/v2", inputHash: sha(factPack), content: verification });
};

const runBlueprint = async (runId: string) => {
  const factPack = requireContent(await getArtifact(runId, "fact-pack"), "fact-pack");
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const startedAt = Date.now();
  const raw = await generateStructuredText<Json>({ schemaName: "lesson_blueprint", jsonSchema: blueprintJsonSchema, prompt: `${await validationFeedback(runId, "blueprint")}Create an educational lesson blueprint for ${run.title}. Return schemaVersion "lesson-blueprint/v2", objective, prerequisites, hook, recap, optional knowledgeCheck {question,options,answerIndex}, and scenes [{id,order,purpose,claimIds,visualBeat}]. Each scene must have one meaningful visual beat, strictly increasing order, at least one cited claim ID, and together the scenes must cover every critical claim. Do not invent claims.\n${JSON.stringify(factPack)}` });
  await recordUsage(runId, "blueprint", "openai", process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra", startedAt, raw.usage, "blueprint/v2", contextManifest("verified-fact-catalog/v1", [{ role: "fact-pack", hash: sha(factPack), chars: JSON.stringify(factPack).length, itemCount: FactPackSchema.parse(factPack).claims.length }]));
  const blueprint = BlueprintV2Schema.parse(raw.value);
  const parsedFactPack = FactPackSchema.parse(requireContent(await getArtifact(runId, "fact-pack"), "fact-pack"));
  const allowedClaimIds = new Set(parsedFactPack.claims.map((claim) => claim.id));
  const blueprintIssues = validateBlueprint({ blueprint, criticalClaimIds: parsedFactPack.claims.filter((claim) => claim.critical).map((claim) => claim.id), allowedClaimIds });
  if (blueprintIssues.length) await failWithFindings(runId, "Blueprint QA", blueprintIssues);
  return saveArtifact({ runId, stage: "blueprint", role: "lesson-blueprint", schemaVersion: blueprint.schemaVersion, inputHash: sha(factPack), content: blueprint });
};

const runScript = async (runId: string) => {
  const [blueprint, factPack] = await Promise.all([getArtifact(runId, "lesson-blueprint"), getArtifact(runId, "fact-pack")]);
  const startedAt = Date.now();
  const blueprintContent = requireContent<{ scenes: Array<{ id: string; claimIds: string[]; purpose: string; visualBeat: string }> }>(blueprint, "lesson-blueprint");
  const factPackContent = FactPackSchema.parse(requireContent(factPack, "fact-pack"));
  const scriptContext = projectScriptContext(factPackContent, blueprintContent);
  const raw = await generateStructuredText<Json>({ schemaName: "approved_script", jsonSchema: scriptJsonSchema, prompt: `${await validationFeedback(runId, "script")}Write narration strictly from this scene plan and its verified claims. Return schemaVersion "approved-script/v2" and narration [{id,sceneId,text,claimIds,visualAction}]. Do not introduce uncited claims and do not return a separate fullText field.\n${JSON.stringify(scriptContext)}` });
  await recordUsage(runId, "script", "openai", process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra", startedAt, raw.usage, "script/v2", contextManifest("scene-claim-projection/v1", [{ role: "script-context", hash: sha(scriptContext), chars: JSON.stringify(scriptContext).length, itemCount: scriptContext.claims.length + scriptContext.scenes.length }]));
  const script = ApprovedScriptSchema.parse(raw.value); const claimIds = new Set(factPackContent.claims.map((claim) => claim.id)); const sceneIds = new Set(blueprintContent.scenes.map((scene) => scene.id)); if (script.narration.some((line) => !sceneIds.has(line.sceneId) || line.claimIds.some((claimId) => !claimIds.has(claimId)))) throw new Error("Script contains an invalid scene or claim reference");
  const verifierStartedAt = Date.now();
  const verificationContext = { schemaVersion: "script-verification-context/v1", narration: script.narration, claims: factPackContent.claims.filter((claim) => new Set(script.narration.flatMap((line) => line.claimIds)).has(claim.id)) };
  const verificationResult = await verifyClaims(`Independently verify every narration line against only its supplied verified claims. Return schemaVersion "script-verification/v2", one evidence item per line with lineId, supported, unsupportedClaimIds, rationale, and notes. Do not rewrite the script.\n${JSON.stringify(verificationContext)}`);
  await recordUsage(runId, "script", "gemini", process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash", verifierStartedAt, verificationResult.usage, "script-verification/v2", contextManifest("line-claim-projection/v1", [{ role: "script-verification-context", hash: sha(verificationContext), chars: JSON.stringify(verificationContext).length, itemCount: script.narration.length }]));
  const verification = ScriptVerificationSchema.parse(verificationResult.value);
  assertScriptVerificationComplete(verification, script);
  return saveArtifact({ runId, stage: "script", role: "approved-script", schemaVersion: script.schemaVersion, inputHash: sha([blueprint?.sha256, factPack?.sha256]), content: script });
};

const runVisualBible = async (runId: string) => {
  const script = ApprovedScriptSchema.parse(requireContent(await getArtifact(runId, "approved-script"), "approved-script"));
  const startedAt = Date.now();
  const visualContext = projectVisualContext(script);
  const bibleResult = await generateStructuredText<Json>({ schemaName: "visual_bible", jsonSchema: visualBibleJsonSchema, prompt: `${await validationFeedback(runId, "visual-bible")}Create a locked visual bible from this narration/visual-action projection. Return schemaVersion "visual-bible/v1", canvasTexture, lineStyle, palette, typography {heading,body,caption}, captionSafeArea {top,right,bottom,left} as fractions, persistentEntities [{id,description}], camera {behavior,transitions}, and prohibitedVisualPatterns. Do not alter narration.\n${JSON.stringify(visualContext)}` });
  await recordUsage(runId, "visual-bible", "openai", process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra", startedAt, bibleResult.usage, "visual-bible/v1", contextManifest("visual-action-projection/v1", [{ role: "visual-context", hash: sha(visualContext), chars: JSON.stringify(visualContext).length, itemCount: visualContext.narration.length }]));
  const bible = VisualBibleSchema.parse(bibleResult.value);
  return saveArtifact({ runId, stage: "visual-bible", role: "visual-bible", schemaVersion: "visual-bible/v1", inputHash: sha(script), content: bible });
};

export const sceneDiagramArea = (canvas: { width: number; height: number }) => ({
  x: Math.round(canvas.width * 0.12),
  y: Math.round(canvas.height * 0.28),
  width: Math.round(canvas.width * 0.76),
  height: Math.round(canvas.height * 0.48),
});

const runAssets = async (runId: string) => {
  const [scriptArtifact, bibleArtifact, blueprintArtifact, factArtifact, run] = await Promise.all([
    getArtifact(runId, "approved-script"), getArtifact(runId, "visual-bible"),
    getArtifact(runId, "lesson-blueprint"), getArtifact(runId, "fact-pack"), getRun(runId),
  ]);
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const bible = VisualBibleSchema.parse(requireContent(bibleArtifact, "visual-bible"));
  const blueprint = BlueprintSchema.parse(requireContent(blueprintArtifact, "lesson-blueprint"));
  const factPack = FactPackSchema.parse(requireContent(factArtifact, "fact-pack"));
  if (!run) throw new Error("Run not found");
  const inputHash = sha([script, bible, blueprint, factPack]);
  const existing = await getArtifact(runId, "selected-assets");
  if (existing?.inputHash === inputHash) return existing;

  const directions = buildSceneDirections({ blueprint, script, factPack });
  const planned = directions.map((direction) => ({ direction, ...buildSceneAssetBrief(direction, { persistentEntities: bible.persistentEntities }) }));
  const plans = buildScenePlans(planned.map((entry) => entry.model));
  const briefs = buildSceneAssetBriefs(planned.map((entry) => entry.brief));
  const soundPlan = buildSoundPlan(directions);
  const scenePlanArtifact = await saveArtifact({ runId, stage: "assets", role: "scene-plans", schemaVersion: plans.schemaVersion, inputHash: sha(blueprint), content: plans, provenance: { provider: "deterministic", model: "scene-plan/v1" } });
  const briefArtifact = await saveArtifact({ runId, stage: "assets", role: "scene-asset-briefs", schemaVersion: briefs.schemaVersion, inputHash: sha([blueprint, factPack]), content: briefs, provenance: { provider: "deterministic", model: "scene-asset-brief/v1" } });
  const soundPlanArtifact = await saveArtifact({ runId, stage: "assets", role: "sound-plan", schemaVersion: soundPlan.schemaVersion, inputHash: sha([blueprint, script]), content: soundPlan, provenance: { provider: "deterministic", model: "sound-plan/v1" } });

  const canvas = run.snapshot.aspectRatio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const area = sceneDiagramArea(canvas);
  const allowedClaimIds = new Set(factPack.claims.map((claim) => claim.id));
  const lockedTexts = [factPack.claims.map((claim) => claim.text).join("\n"), script.narration.map((line) => `${line.text} ${line.visualAction}`).join("\n"), blueprint.scenes.map((scene) => `${scene.purpose} ${scene.visualBeat}`).join("\n")];
  const palette: DiagramPalette = { canvasTexture: bible.canvasTexture, palette: bible.palette, typography: { heading: bible.typography.heading, body: bible.typography.body } };

  const assets = await Promise.all(planned.map(async ({ direction, model }) => {
    const role = "diagram-" + direction.sceneId;
    const existingAsset = (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.selected, true))))[0];
    if (existingAsset) return existingAsset;
    const rendered = renderAndValidateDiagram({ model, palette, canvas, area, lockedTexts, allowedClaimIds });
    if (!rendered.passed) {
      await getDb().insert(qaFindings).values(rendered.issues.map((issue) => ({ runId, rule: issue.rule, severity: "critical" as const, evidence: { sceneId: direction.sceneId, ...issue.evidence }, remediation: issue.remediation })));
      throw new Error(`Diagram QA failed for scene ${direction.sceneId}: ${rendered.issues.map((issue) => issue.rule).join(", ")}`);
    }
    const object = await putPrivateObject({ key: `runs/${runId}/assets/scene-${direction.sceneId}.svg`, body: rendered.svg, contentType: "image/svg+xml" });
    const [asset] = await getDb().insert(mediaAssets).values({
      runId, sceneId: direction.sceneId, role, objectKey: object.key, sha256: object.sha256, mimeType: "image/svg+xml",
      byteSize: object.byteSize, width: canvas.width, height: canvas.height, selected: true,
      provenance: {
        kind: "typed-svg", diagramKind: model.kind, labels: model.labels, diagramModelHash: sha(model),
        scenePlanArtifactId: scenePlanArtifact.id, sceneAssetBriefArtifactId: briefArtifact.id,
        scriptHash: sha(script), visualBibleHash: sha(bible),
      },
    }).onConflictDoNothing().returning();
    const stableAsset = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.sha256, object.sha256))))[0];
    if (!stableAsset) throw new Error("Selected asset persistence failed");
    if (rendered.layout.anchors.length) {
      await getDb().insert(assetAnchors).values(rendered.layout.anchors.map((anchor) => ({
        assetId: stableAsset.id, name: anchor.name, x: Math.round(anchor.x * 1_000_000), y: Math.round(anchor.y * 1_000_000),
        provider: "svg", confidenceMillionths: 1_000_000,
      }))).onConflictDoNothing();
    }
    return stableAsset;
  }));

  // Optional illustration enrichment. It is never required: capability absence,
  // verification failure, or generation failure is recorded as an explicit
  // omission, and a selected illustration always requires human review before
  // publication because image-model style/text adherence is a reviewer gate.
  const illustrationAvailable = resolveCapabilities(run.domain).some((capability) => capability.capability === "illustration" && capability.available);
  const illustrationModel = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";
  const illustrationDecisions = await Promise.all(planned.map(async ({ direction, brief }): Promise<{ sceneId: string; choice: "selected" | "omitted"; role?: string; assetId?: string; reason: string }> => {
    if (!brief.illustration.required) return { sceneId: direction.sceneId, choice: "omitted", reason: brief.illustration.reason ?? "No illustration planned for this scene." };
    const role = "illustration-" + direction.sceneId;
    const existingIllustration = (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.selected, true))))[0];
    if (existingIllustration) return { sceneId: direction.sceneId, choice: "selected", role, assetId: existingIllustration.id, reason: brief.illustration.reason ?? "Existing selected illustration reused." };
    if (!illustrationAvailable) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration capability is unavailable; the deterministic vector treatment is used instead." };
    const startedAt = Date.now();
    try {
      const stylePrompt = `${brief.illustration.prompt}\nVisual bible: canvas texture ${bible.canvasTexture}; line style ${bible.lineStyle}; palette ${bible.palette.join(", ")}; body font ${bible.typography.body}.`;
      const generated = await generateIllustration(stylePrompt);
      const issues = validateIllustrationCandidate({ bytes: generated.bytes, mimeType: generated.mimeType });
      await recordUsage(runId, "assets", "gemini", illustrationModel, startedAt, generated.usage, "illustration/v1", contextManifest("scene-asset-brief/v1", [{ role: "scene-asset-briefs", hash: briefArtifact.sha256 ?? sha(briefs), chars: JSON.stringify(brief).length, itemCount: 1 }]), issues.length ? "failed" : "completed", issues.length ? "ILLUSTRATION_VERIFICATION" : undefined);
      if (issues.length) {
        await getDb().insert(qaFindings).values(issues.map((issue) => ({ runId, rule: issue.rule, severity: "warning" as const, evidence: { sceneId: direction.sceneId, ...issue.evidence }, remediation: issue.remediation })));
        return { sceneId: direction.sceneId, choice: "omitted", reason: "Generated illustration failed deterministic verification; deterministic vector treatment retained." };
      }
      const dimensions = imageDimensions(generated.bytes, generated.mimeType);
      if (!dimensions) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration dimensions were unreadable; deterministic vector treatment retained." };
      const object = await putPrivateObject({ key: `runs/${runId}/assets/illustration-${direction.sceneId}`, body: generated.bytes, contentType: generated.mimeType });
      const [asset] = await getDb().insert(mediaAssets).values({ runId, sceneId: direction.sceneId, role, objectKey: object.key, sha256: object.sha256, mimeType: generated.mimeType, byteSize: object.byteSize, width: dimensions.width, height: dimensions.height, selected: true, provenance: { kind: "illustration", provider: "gemini", model: illustrationModel, prompt: brief.illustration.prompt, prohibitedText: true, briefReason: brief.illustration.reason, sceneAssetBriefArtifactId: briefArtifact.id, visualBibleHash: sha(bible) } }).onConflictDoNothing().returning();
      const stable = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.sha256, object.sha256))))[0];
      if (!stable) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration persistence failed; deterministic vector treatment retained." };
      return { sceneId: direction.sceneId, choice: "selected", role, assetId: stable.id, reason: brief.illustration.reason ?? "Selected illustration." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "illustration generation failed";
      await recordUsage(runId, "assets", "gemini", illustrationModel, startedAt, { model: illustrationModel }, "illustration/v1", { projection: "scene-asset-brief/v1" }, "failed", error instanceof ProviderError ? error.code : "ILLUSTRATION_GENERATION");
      return { sceneId: direction.sceneId, choice: "omitted", reason: `Illustration generation failed and was recorded as an omission: ${message}` };
    }
  }));
  const illustrationAssetIds = illustrationDecisions.flatMap((decision) => (decision.assetId ? [decision.assetId] : []));
  const content = {
    assetIds: [...assets.map((asset) => asset.id), ...illustrationAssetIds],
    composition: "typed-scene-svg",
    visualBibleHash: sha(bible),
    scenePlanArtifactId: scenePlanArtifact.id,
    sceneAssetBriefArtifactId: briefArtifact.id,
    soundPlanArtifactId: soundPlanArtifact.id,
    diagramKinds: planned.map(({ direction, model }) => ({ sceneId: direction.sceneId, kind: model.kind, labels: model.labels })),
    // Persist the typed models so the independent visual QA branch can
    // re-render and re-validate geometry/vocabulary from locked evidence.
    diagramModels: planned.map(({ model }) => model),
    illustrationDecisions,
  };
  return saveArtifact({ runId, stage: "assets", role: "selected-assets", schemaVersion: "selected-assets/v1", inputHash, content });
};

const runVoiceover = async (runId: string) => {
  const script = ApprovedScriptSchema.parse(requireContent(await getArtifact(runId, "approved-script"), "approved-script"));
  const inputHash = sha(script);
  const existing = await getArtifact(runId, "voiceover");
  if (existing?.inputHash === inputHash) return existing;
  const startedAt = Date.now();
  const narrationResult = await synthesizeNarration(canonicalNarrationText(script));
  await recordUsage(runId, "voiceover", "elevenlabs", process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2", startedAt, narrationResult.usage, "voiceover/v2", contextManifest("canonical-narration/v1", [{ role: "approved-script", hash: inputHash, chars: canonicalNarrationText(script).length, itemCount: script.narration.length }]));
  const narration = narrationResult.value;
  const probeDir = await mkdtemp(join(tmpdir(), "upcraft-voice-"));
  let measuredDurationMs: number;
  try {
    const audioPath = join(probeDir, "narration.mp3");
    await writeFile(audioPath, narration.bytes);
    measuredDurationMs = await probeAudioDurationMs(audioPath);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
  const voiceIssues = validateVoiceAlignment({ words: narration.words, measuredDurationMs });
  if (voiceIssues.length) await failWithFindings(runId, "Voiceover QA", voiceIssues);
  const object = await putPrivateObject({ key: `runs/${runId}/audio/narration.mp3`, body: narration.bytes, contentType: "audio/mpeg" });
  const [asset] = await getDb().insert(mediaAssets).values({ runId, role: "narration", objectKey: object.key, sha256: object.sha256, mimeType: "audio/mpeg", byteSize: object.byteSize, selected: true, provenance: { voiceId: process.env.ELEVENLABS_VOICE_ID, model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2" } }).onConflictDoNothing().returning();
  const stableAsset = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, "narration"), eq(mediaAssets.sha256, object.sha256))))[0];
  if (!stableAsset) throw new Error("Narration asset persistence failed");
  return saveArtifact({ runId, stage: "voiceover", role: "voiceover", schemaVersion: "voiceover/v1", inputHash, content: { assetId: stableAsset.id, objectKey: object.key, words: narration.words } });
};

const runCaptions = async (runId: string) => {
  const voiceover = requireContent<{ words: WordTiming[] }>(await getArtifact(runId, "voiceover"), "voiceover");
  const words = voiceover.words;
  if (!words.length || words.some((word, index) => word.endMs <= word.startMs || (index > 0 && word.startMs < (words[index - 1]?.endMs ?? 0)))) throw new Error("Word alignment is invalid");
  const cues = words.reduce<Array<{ text: string; startMs: number; endMs: number; wordIndexes: number[] }>>((result, word, index) => { const current = result.at(-1); if (!current || current.wordIndexes.length >= 8) result.push({ text: word.text, startMs: word.startMs, endMs: word.endMs, wordIndexes: [index] }); else { current.text += " " + word.text; current.endMs = word.endMs; current.wordIndexes.push(index); } return result; }, []);
  return saveArtifact({ runId, stage: "captions", role: "caption-timings", schemaVersion: "caption-timings/v1", inputHash: sha(voiceover), content: { words, cues } });
};

const runSpatialLayout = async (runId: string) => {
  const script = ApprovedScriptSchema.parse(requireContent(await getArtifact(runId, "approved-script"), "approved-script"));
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const canvas = run.snapshot.aspectRatio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const sceneIds = [...new Set(script.narration.map((line) => line.sceneId))];
  const layouts = sceneIds.map((sceneId) => ResolvedLayoutSchema.parse({
    schemaVersion: "resolved-layout/v1",
    sceneId,
    canvas,
    layers: [{ id: "diagram-" + sceneId, matrix: [1, 0, 0, 1, 0, 0], bounds: { x: Math.round(canvas.width * .12), y: Math.round(canvas.height * .28), width: Math.round(canvas.width * .76), height: Math.round(canvas.height * .48) }, zIndex: 1 }],
  }));
  return saveArtifact({ runId, stage: "spatial-layout", role: "resolved-layout", schemaVersion: "resolved-layout/v1", inputHash: sha(script), content: { schemaVersion: "resolved-layout/v1", canvas, layouts } });
};

const runManifest = async (runId: string) => {
  const [run, voiceoverArtifact, captionsArtifact, layoutArtifact, scriptArtifact, blueprintArtifact, bibleArtifact, assets] = await Promise.all([
    getRun(runId), getArtifact(runId, "voiceover"), getArtifact(runId, "caption-timings"), getArtifact(runId, "resolved-layout"),
    getArtifact(runId, "approved-script"), getArtifact(runId, "lesson-blueprint"), getArtifact(runId, "visual-bible"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
  ]);
  if (!run || !voiceoverArtifact || !captionsArtifact || !layoutArtifact || !scriptArtifact || !blueprintArtifact || !bibleArtifact) throw new Error("Manifest prerequisites are incomplete");
  const voiceover = requireContent<{ assetId?: string }>(voiceoverArtifact, "voiceover");
  if (!voiceover.assetId) throw new Error("Voiceover has no persisted narration asset");
  const captions = requireContent<{ words: WordTiming[]; cues: Array<{ text: string; startMs: number; endMs: number; wordIndexes: number[] }> }>(captionsArtifact, "caption-timings");
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const blueprint = requireContent<{ scenes: Array<{ id: string; purpose: string; visualBeat: string }> }>(blueprintArtifact, "lesson-blueprint");
  const bible = requireContent<{ captionSafeArea: { top: number; right: number; bottom: number; left: number } }>(bibleArtifact, "visual-bible");
  const layoutBundle = requireContent<{ canvas: { width: number; height: number }; layouts: unknown[] }>(layoutArtifact, "resolved-layout");
  const layouts = layoutBundle.layouts.map((layout) => ResolvedLayoutSchema.parse(layout));
  const normalizeWord = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  let wordCursor = 0;
  const boundaries = new Map<string, { startMs: number; endMs: number; visualBeat: string }>();
  for (const line of script.narration) {
    const expected = line.text.trim().split(/\s+/).filter(Boolean);
    const actual = captions.words.slice(wordCursor, wordCursor + expected.length);
    if (actual.length !== expected.length || actual.some((word, index) => normalizeWord(word.text) !== normalizeWord(expected[index] ?? ""))) throw new Error("Voice alignment does not match approved script line " + line.id);
    const first = actual[0]; const last = actual.at(-1);
    if (!first || !last) throw new Error("Voice alignment is missing for script line " + line.id);
    const current = boundaries.get(line.sceneId);
    boundaries.set(line.sceneId, { startMs: current ? Math.min(current.startMs, first.startMs) : first.startMs, endMs: Math.max(current?.endMs ?? 0, last.endMs), visualBeat: line.visualAction });
    wordCursor += expected.length;
  }
  if (wordCursor !== captions.words.length) throw new Error("Voice alignment contains words outside the approved script");
  const safeArea = { top: Math.round(bible.captionSafeArea.top * layoutBundle.canvas.height), right: Math.round(bible.captionSafeArea.right * layoutBundle.canvas.width), bottom: Math.round(bible.captionSafeArea.bottom * layoutBundle.canvas.height), left: Math.round(bible.captionSafeArea.left * layoutBundle.canvas.width) };
  if ([bible.captionSafeArea.top, bible.captionSafeArea.right, bible.captionSafeArea.bottom, bible.captionSafeArea.left].some((value) => value > 1)) throw new Error("Visual bible safe-area values must be fractions");
  const scenes = [...boundaries.entries()].map(([sceneId, timing]) => {
    const layout = layouts.find((candidate) => candidate.sceneId === sceneId);
    const blueprintScene = blueprint.scenes.find((scene) => scene.id === sceneId);
    const asset = assets.find((candidate) => candidate.sceneId === sceneId && candidate.role === "diagram-" + sceneId);
    if (!layout || !blueprintScene || !asset) throw new Error("Manifest scene " + sceneId + " is missing layout, blueprint, or selected asset");
    const illustration = assets.find((candidate) => candidate.sceneId === sceneId && candidate.role === "illustration-" + sceneId);
    const layers = [
      ...(illustration ? [{ id: "illustration-" + sceneId, kind: "illustration" as const, assetId: illustration.id, zIndex: 0, bounds: { x: 0, y: 0, width: layoutBundle.canvas.width, height: layoutBundle.canvas.height } }] : []),
      ...layout.layers.map((layer) => ({ id: layer.id, kind: "diagram" as const, assetId: asset.id, zIndex: layer.zIndex, bounds: layer.bounds })),
    ];
    return { sceneId, layoutArtifactId: layoutArtifact.id, startMs: timing.startMs, endMs: timing.endMs, title: blueprintScene.purpose, visualBeat: timing.visualBeat, layers };
  });
  const manifest = ProjectManifestSchema.parse({ schemaVersion: "video-manifest/v1", fps: 30, canvas: layoutBundle.canvas, safeArea, narrationAssetId: voiceover.assetId, words: captions.words, captions: captions.cues, scenes });
  return saveArtifact({ runId, stage: "manifest", role: "project-manifest", schemaVersion: manifest.schemaVersion, inputHash: sha([voiceoverArtifact?.sha256, captionsArtifact?.sha256, layoutArtifact?.sha256]), content: manifest });
};

const render = async (runId: string, kind: "preview" | "final") => {
  const [run, manifestArtifact, voiceoverArtifact, assets] = await Promise.all([getRun(runId), getArtifact(runId, "project-manifest"), getArtifact(runId, "voiceover"), getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true)))]);
  if (!run) throw new Error("Run not found");
  const storedManifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const assetUrls = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await getPrivateReadUrl(asset.objectKey, 3_600)] as const)));
  const missingAssets = storedManifest.scenes.flatMap((scene) => scene.layers).filter((layer) => layer.assetId && !assetUrls.has(layer.assetId));
  if (missingAssets.length) await failWithFindings(runId, "Pre-render asset availability", missingAssets.map((layer) => ({ rule: "render-asset-unavailable", evidence: { layerId: layer.id, assetId: layer.assetId }, remediation: "Restore the missing selected asset before rendering; never render a placeholder in its place." })));
  const manifest = ProjectManifestSchema.parse({ ...storedManifest, scenes: storedManifest.scenes.map((scene) => ({ ...scene, layers: scene.layers.map((layer) => ({ ...layer, ...(layer.assetId && assetUrls.get(layer.assetId) ? { assetUrl: assetUrls.get(layer.assetId) } : {}) })) })) });
  const voiceover = requireContent<{ objectKey: string }>(voiceoverArtifact, "voiceover");
  const outputPath = join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId, `${kind}.mp4`);
  await mkdir(join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId), { recursive: true });
  await renderLesson({ title: run.title, manifest, audioUrl: await getPrivateReadUrl(voiceover.objectKey, 3_600), outputPath });
  const probe = await probeMedia(outputPath);
  const expectedDurationMs = manifest.words.at(-1)?.endMs ?? 0;
  const expectedFrames = Math.ceil((expectedDurationMs / 1000) * manifest.fps);
  const renderIssues = validateRenderIntegrity({ probe, expectedDurationMs, expectedWidth: manifest.canvas.width, expectedHeight: manifest.canvas.height, expectedFps: manifest.fps, expectedFrames, requiredVideoCodec: "h264" });
  if (renderIssues.length) await failWithFindings(runId, "Render integrity QA", renderIssues);
  const renderer = rendererVersion();
  await getDb().update(videoRuns).set({ rendererVersion: renderer }).where(eq(videoRuns.id, runId));
  const bytes = await readFile(outputPath);
  const object = await putPrivateObject({ key: `runs/${runId}/renders/${kind}.mp4`, body: bytes, contentType: "video/mp4" });
  await getDb().insert(renderOutputs).values({ runId, kind, objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs, width: manifest.canvas.width, height: manifest.canvas.height }).onConflictDoUpdate({ target: [renderOutputs.runId, renderOutputs.kind], set: { objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs } });
  const provenance = { objectKey: object.key, sha256: object.sha256, durationMs: probe.durationMs, frameCount: deriveFrameCount(probe), width: probe.width, height: probe.height, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, rendererVersion: renderer, composition: "Lesson", exportProfile: "h264/aac/jpeg" };
  return saveArtifact({ runId, stage: kind === "preview" ? "preview-render" : "final-render", role: `${kind}-render`, schemaVersion: "render-output/v1", inputHash: sha(manifest), content: provenance });
};

const ZERO_MEDIA_PROBE: MediaProbe = { durationMs: 0, width: 0, height: 0, fps: 0, videoCodec: "", audioCodec: null, hasAudio: false };

/** Probes a stored private object through a temp file; nothing trusts the request. */
const probePrivateMedia = async <T>(params: { objectKey: string; fileName: string; probe: (path: string) => Promise<T> }): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "upcraft-qa-"));
  try {
    const path = join(dir, params.fileName);
    await writeFile(path, await getPrivateObject(params.objectKey));
    return await params.probe(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runQa = async (runId: string) => {
  const [captionArtifact, manifestArtifact, previewArtifact, factArtifact, scriptArtifact, layoutArtifact, assets, run, sources, selectedAssetsArtifact, blueprintArtifact, bibleArtifact] = await Promise.all([
    getArtifact(runId, "caption-timings"), getArtifact(runId, "project-manifest"), getArtifact(runId, "preview-render"),
    getArtifact(runId, "fact-pack"), getArtifact(runId, "approved-script"), getArtifact(runId, "resolved-layout"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
    getRun(runId), getDb().select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId)), getArtifact(runId, "selected-assets"),
    getArtifact(runId, "lesson-blueprint"), getArtifact(runId, "visual-bible"),
  ]);
  const captions = requireContent<{ words: WordTiming[]; cues: Array<{ wordIndexes: number[] }> }>(captionArtifact, "caption-timings");
  const manifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const bible = VisualBibleSchema.parse(requireContent(bibleArtifact, "visual-bible"));
  const requiredArtifacts: Array<[string, unknown]> = [["fact-pack", factArtifact], ["approved-script", scriptArtifact], ["resolved-layout", layoutArtifact], ["project-manifest", manifestArtifact], ["lesson-blueprint", blueprintArtifact], ["visual-bible", bibleArtifact]];
  const missingArtifacts = requiredArtifacts.filter(([, artifact]) => !artifact).map(([role]) => role);
  const scriptSceneCount = new Set(script.narration.map((line) => line.sceneId)).size;

  const selectedAssetsContent = selectedAssetsArtifact?.content as { diagramKinds?: Array<{ labels?: string[] }>; diagramModels?: unknown[] } | undefined;
  const diagramLabels = selectedAssetsContent?.diagramKinds?.flatMap((entry) => entry.labels ?? []) ?? [];
  const factPack = factArtifact ? FactPackSchema.parse(requireContent(factArtifact, "fact-pack")) : undefined;
  const blueprint = blueprintArtifact ? requireContent<{ objective: string; scenes: Array<{ id: string; purpose: string; visualBeat: string }> }>(blueprintArtifact, "lesson-blueprint") : undefined;
  const diagramModels = (selectedAssetsContent?.diagramModels ?? []).flatMap((model) => {
    const parsed = DiagramModelSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
  const layoutBundle = layoutArtifact ? requireContent<{ canvas: { width: number; height: number }; layouts: unknown[] }>(layoutArtifact, "resolved-layout") : undefined;
  const layouts = (layoutBundle?.layouts ?? []).map((layout) => ResolvedLayoutSchema.parse(layout));

  // Narration and preview are re-probed from their stored bytes so the audio and
  // render-integrity findings cannot be satisfied by the pre-render request.
  const narration = assets.find((asset) => asset.role === "narration");
  if (!narration) throw new Error("QA requires the persisted narration asset");
  const narrationDurationMs = await probePrivateMedia({ objectKey: narration.objectKey, fileName: "narration.mp3", probe: probeAudioDurationMs });
  const previewProvenance = previewArtifact ? requireContent<{ objectKey?: string }>(previewArtifact, "preview-render") : undefined;
  const previewProbe = previewProvenance?.objectKey
    ? await probePrivateMedia({ objectKey: previewProvenance.objectKey, fileName: "preview.mp4", probe: probeMedia })
    : ZERO_MEDIA_PROBE;

  const canvas = manifest.canvas;
  const area = sceneDiagramArea(canvas);
  const palette: DiagramPalette = { canvasTexture: bible.canvasTexture, palette: bible.palette, typography: { heading: bible.typography.heading, body: bible.typography.body } };
  const lockedTexts = [script.narration.map((line) => `${line.text} ${line.visualAction}`).join("\n"), ...(factPack && blueprint ? [factPack.claims.map((claim) => claim.text).join("\n"), blueprint.scenes.map((scene) => `${scene.purpose} ${scene.visualBeat}`).join("\n")] : [])];
  const allowedClaimIds = new Set((factPack?.claims ?? []).map((claim) => claim.id));
  const expectedDurationMs = manifest.words.at(-1)?.endMs ?? 0;

  // Tier B is one consolidated, separately routed review. Starting it before
  // the deterministic Tier A checks lets its network round-trip overlap them
  // instead of adding its full latency after they finish.
  const reviewBranch: Promise<QaTierResult> = (async () => {
    if (!run || !factPack || !blueprint) return { tier: "B", issues: [], checks: ["consolidated-review"] };
    const reviewStartedAt = Date.now();
    const reviewContext = {
      objective: blueprint.objective,
      scenes: blueprint.scenes,
      narration: script.narration,
      claims: factPack.claims,
      diagramLabels,
      captions: manifest.captions,
      preview: { durationMs: previewProbe.durationMs, width: previewProbe.width, height: previewProbe.height, fps: previewProbe.fps, hasAudio: previewProbe.hasAudio },
    };
    const reviewResult = await verifyClaims(`Independently review this lesson end to end against its verified claims and stated objective. Return schemaVersion "consolidated-review/v1" and issues [{domain,severity,evidence,remediation}], where domain is factual, pedagogy, visual, or audio. Use severity "critical" only for a genuine defect that blocks release. Do not rewrite the script, invent facts, or add labels.\n${JSON.stringify(reviewContext)}`);
    await recordUsage(runId, "qa", "gemini", process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash", reviewStartedAt, reviewResult.usage, "consolidated-review/v1", contextManifest("consolidated-review-context/v1", [{ role: "fact-pack-script-preview", hash: sha(reviewContext), chars: JSON.stringify(reviewContext).length, itemCount: script.narration.length + factPack.claims.length + manifest.captions.length }]));
    return consolidatedReviewQa(ConsolidatedReviewSchema.parse(reviewResult.value));
  })();

  // Tier A: deterministic, zero-token gates. Nothing here can be satisfied by a
  // model's own claim that its output is valid.
  const tierA = deterministicQa(
    structuralQa({
      captions, previewPresent: Boolean(previewArtifact), missingArtifacts,
      sceneCount: manifest.scenes.length, scriptSceneCount,
      assetIds: assets.map((asset) => asset.id),
      sceneAssetIds: manifest.scenes.map((scene) => scene.layers.find((layer) => layer.assetId)?.assetId),
      ...(run && factPack && blueprint ? { domainPolicy: { domain: run.domain, script, factPack, blueprint, diagramLabels, sources: sources.map((source) => ({ sourceUrl: source.sourceUrl, retrievedAt: source.retrievedAt })), assets: assets.map((asset) => ({ role: asset.role, provenance: asset.provenance })) } } : {}),
    }),
    visualQa({ canvas, safeArea: manifest.safeArea, captions: manifest.captions, words: manifest.words, lockedTexts, allowedClaimIds, diagramModels, palette, area }),
    audioRenderQa({ words: manifest.words, narrationDurationMs, preview: previewProbe, expected: { durationMs: expectedDurationMs, width: canvas.width, height: canvas.height, fps: manifest.fps, frames: Math.ceil((expectedDurationMs / 1000) * manifest.fps), codec: "h264" } }),
    spatialQa({ canvas, safeArea: manifest.safeArea, layouts }),
  );
  const tierB = await reviewBranch;

  // Both tiers must report before approval may be scheduled, and any critical
  // finding fails the run through the existing visible-failure path.
  const convergence = convergeQaTiers([tierA, tierB]);
  if (!convergence.complete) throw new Error("Release QA tiers did not converge: " + convergence.missing.join(", "));
  if (convergence.issues.length) {
    await getDb().insert(qaFindings).values(convergence.issues.map((issue) => ({ runId, rule: issue.rule, severity: "critical" as const, evidence: issue.evidence, remediation: issue.remediation })));
    throw new Error("Release QA failed: " + convergence.issues.map((issue) => issue.rule).join(", "));
  }
  return saveArtifact({
    runId, stage: "qa", role: "qa-report", schemaVersion: "qa-report/v1", inputHash: sha([manifest, captions]),
    content: { passed: true, tiers: [tierA, tierB].map((tier) => ({ tier: tier.tier, checks: tier.checks, findings: tier.issues.length })), checks: convergence.checks },
  });
};

const runReleaseRecord = async (runId: string) => {
  const db = getDb();
  const [run, outputArtifact, manifestArtifact, qaArtifact, sources, claims, artifactRows, checkpoints, usage, approvalRows, renders, intake] = await Promise.all([
    getRun(runId), getArtifact(runId, "final-render"), getArtifact(runId, "project-manifest"), getArtifact(runId, "qa-report"),
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
  const recordContent = { schemaVersion: "release-record/v1", releasedAt: new Date().toISOString(), run: { id: run.id, title: run.title, domain: run.domain, snapshot: run.snapshot, snapshotHash: run.snapshotHash }, intake: intake ? { sessionId: intake.id, inputHash: intake.inputHash, brief: intake.brief, briefHash: intake.briefHash, attempts: intakeAttemptsRows.map((attempt) => ({ attempt: attempt.attempt, provider: attempt.provider, model: attempt.model, requestId: attempt.requestId, promptVersion: attempt.promptVersion, outcome: attempt.outcome, inputTokens: attempt.inputTokens, cachedInputTokens: attempt.cachedInputTokens, outputTokens: attempt.outputTokens, reasoningTokens: attempt.reasoningTokens, latencyMs: attempt.latencyMs, contextManifest: attempt.contextManifest })) } : null, finalOutput: output, manifest: manifestArtifact.content, qa: qaArtifact.content, sources: sources.map((source) => ({ id: source.id, name: source.originalName, url: source.sourceUrl, sha256: source.sha256, sourceBytesSha256: source.sourceBytesSha256, retrievedAt: source.retrievedAt?.toISOString() ?? null })), claims: claims.map((claim) => ({ id: claim.id, sourceId: claim.sourceId, claim: claim.claim, locator: claim.locator, evidence: claim.evidence, critical: claim.critical, verifiedAt: claim.verifiedAt?.toISOString() ?? null, verifierModel: claim.verifierModel })), artifacts: artifactRows.map((artifact) => ({ id: artifact.id, stage: artifact.stage, role: artifact.role, version: artifact.version, sha256: artifact.sha256, inputHash: artifact.inputHash, schemaVersion: artifact.schemaVersion, provenance: artifact.provenance })), checkpoints: checkpoints.map((checkpoint) => ({ stage: checkpoint.stage, inputHash: checkpoint.inputHash, outputHash: checkpoint.outputHash, outcome: checkpoint.outcome, evidence: checkpoint.evidence })), providerUsage: usage.map((entry) => ({ stage: entry.stage, provider: entry.provider, model: entry.model, requestId: entry.requestId, outcome: entry.outcome, latencyMs: entry.latencyMs, inputTokens: entry.inputTokens, cachedInputTokens: entry.cachedInputTokens, outputTokens: entry.outputTokens, reasoningTokens: entry.reasoningTokens, inputCharacters: entry.inputCharacters, outputCharacters: entry.outputCharacters, costMicrounits: entry.costMicrounits, pricingVersion: entry.pricingVersion, promptVersion: entry.promptVersion, contextManifest: entry.contextManifest })), approvals: approvalRows.map((approval) => ({ decision: approval.decision, reviewerId: approval.reviewerId, clinicianApproverId: approval.clinicianApproverId, notes: approval.notes })), renders: renders.map((renderOutput) => ({ kind: renderOutput.kind, sha256: renderOutput.sha256, durationMs: renderOutput.durationMs, width: renderOutput.width, height: renderOutput.height })) };
  const record = await saveArtifact({ runId, stage: "release-record", role: "release-record", schemaVersion: "release-record/v1", inputHash: sha(recordContent), content: recordContent });
  await setRunStatus(runId, "completed", { stage: "release-record" });
  await evaluateCostReviewAlert(runId);
  return record;
};

const stageHandlers: Record<Exclude<StageName, "approval" | "final-render" | "release-record" | "preview-render" | "qa">, (runId: string) => Promise<unknown>> = {
  "preflight": runPreflight, "research": runResearch, "fact-verification": runFactVerification, "blueprint": runBlueprint,
  "script": runScript, "visual-bible": runVisualBible, "assets": runAssets, "voiceover": runVoiceover,
  "captions": runCaptions, "spatial-layout": runSpatialLayout, "manifest": runManifest,
};

const stageInputRoles: Partial<Record<StageName, string[]>> = {
  "fact-verification": ["source-evidence-map", "fact-pack"],
  blueprint: ["fact-pack"],
  script: ["lesson-blueprint", "fact-pack"],
  "visual-bible": ["approved-script"],
  assets: ["approved-script", "visual-bible", "lesson-blueprint", "fact-pack"],
  voiceover: ["approved-script"],
  captions: ["voiceover"],
  "spatial-layout": ["approved-script", "visual-bible", "selected-assets"],
  manifest: ["voiceover", "caption-timings", "resolved-layout", "approved-script", "lesson-blueprint", "visual-bible", "selected-assets"],
  "preview-render": ["project-manifest", "voiceover", "selected-assets"],
  qa: ["preview-render", "project-manifest", "fact-pack", "approved-script", "resolved-layout", "selected-assets"],
  approval: ["qa-report", "preview-render"],
  "final-render": ["project-manifest", "voiceover", "selected-assets"],
  "release-record": ["final-render", "project-manifest", "qa-report"],
};

/** Hashes the locked rows actually consumed by a stage, never only the run ID. */
export const getStageInputHash = async (runId: string, stage: StageName) => {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const db = getDb();
  const roles = stageInputRoles[stage] ?? [];
  const lockedArtifacts = [];
  for (const role of roles) {
    const artifact = await getArtifact(runId, role);
    lockedArtifacts.push({ role, id: artifact?.id ?? null, sha256: artifact?.sha256 ?? null, inputHash: artifact?.inputHash ?? null, schemaVersion: artifact?.schemaVersion ?? null });
  }
  const sources = await db.select({ id: sourceDocuments.id, sha256: sourceDocuments.sha256, sourceBytesSha256: sourceDocuments.sourceBytesSha256, retrievedAt: sourceDocuments.retrievedAt }).from(sourceDocuments).where(eq(sourceDocuments.runId, runId)).orderBy(asc(sourceDocuments.id));
  return sha({ snapshotHash: run.snapshotHash, stage, artifacts: lockedArtifacts, sources });
};

export const processPipelineStage = async (runId: string, stage: StageName) => {
  const run = await getRun(runId);
  if (!run || run.status === "completed") return;
  if (stage === "approval") return;
  const owner = process.env.PIPELINE_WORKER_ID ?? `worker-${process.pid}`;
  const inputHash = await getStageInputHash(runId, stage);
  const lease = await claimStageLease({ runId, stage, inputHash, owner });
  if (!lease) return;
  const leaseHeartbeat = startStageLeaseHeartbeat({ runId, stage, leaseToken: lease.leaseToken, owner });
  await setRunStatus(runId, "running", { stage });
  await appendRunEvent(runId, stage, "stage_started", `${stage} started.`, {});
  const stageStartedAt = Date.now();
  try {
    let result: unknown;
    if (stage === "preview-render") result = await render(runId, "preview");
    else if (stage === "qa") result = await runQa(runId);
    else if (stage === "final-render") result = await render(runId, "final");
    else if (stage === "release-record") result = await runReleaseRecord(runId);
    else result = await stageHandlers[stage](runId);

    // Fence the stage result before checkpointing: a reclaimed lease means
    // this worker's output is stale and cannot advance the pipeline.
    await leaseHeartbeat.stop();
    const outputHash = result && typeof result === "object" && "sha256" in result && typeof result.sha256 === "string" ? result.sha256 : sha(result);
    await checkpointStage({ runId, stage, inputHash, outputHash, outcome: "valid", leaseToken: lease.leaseToken, leaseOwner: owner, evidence: { stageInputHash: inputHash, leaseExpiresAt: lease.leaseExpiresAt.toISOString() } });
    await appendRunEvent(runId, stage, "stage_completed", `${stage} completed.`, {});
    const next = nextStage(stage);
    if (next === "approval") {
      const illustrationCount = (await getDb().select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true), like(mediaAssets.role, "illustration-%")))).length;
      if (illustrationCount > 0) await appendRunEvent(runId, "approval", "qa", "Selected AI illustrations require reviewer approval before publication.", { illustrationCount });
      const automatic = run.domain === "standard" && ["school", "college"].includes(run.snapshot.audienceCategory) && illustrationCount === 0;
      if (automatic) {
        await getDb().insert(approvals).values({ runId, decision: "approved", reviewerId: "automated-release-gates", notes: "Automated standard school/college release gates passed." });
        await setRunStatus(runId, "running", { stage: "final-render" });
      await checkpointStage({ runId, stage: "approval", inputHash: await getStageInputHash(runId, "approval"), outputHash: sha({ decision: "approved", reviewerId: "automated-release-gates" }), outcome: "valid" });
        await appendRunEvent(runId, "approval", "approval", "Automated release gates approved the run for final render.", { reviewerId: "automated-release-gates" });
        await scheduleStage(runId, "final-render");
        return;
      }
      await setRunStatus(runId, "awaiting_approval", { stage: "approval" });
      await checkpointStage({ runId, stage: "approval", inputHash: await getStageInputHash(runId, "approval"), outcome: "awaiting_approval" });
      await appendRunEvent(runId, "approval", "status", "Run is awaiting approval.", {});
      return;
    }
    if (next) await scheduleStage(runId, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown pipeline error";
    if (error instanceof StageLeaseLostError) {
      await appendRunEvent(runId, stage, "status", `${stage} lease ownership was lost; this worker did not promote its result.`, { code: "STAGE_LEASE_LOST" });
      return;
    }
    const route = routeForStage(stage);
    if (route.provider !== "deterministic") await recordUsage(runId, stage, route.provider, route.model, stageStartedAt, { model: route.model }, `${stage}/v2`, { projection: "unknown-at-failure" }, "failed", error instanceof ProviderError ? error.code : "VALIDATION_OR_STAGE_ERROR");
    if (error instanceof ProviderError && error.retryable) {
      await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", evidence: { message, retryable: true, providerCode: error.code, attempt: lease.attemptCount } });
      await setRunStatus(runId, "queued", { stage });
      await appendRunEvent(runId, stage, "status", `${stage} will retry after a transient provider failure: ${message}`, { code: error.code, status: error.status ?? null });
      throw error;
    }
    const invalidArtifact = decideInvalidArtifactRetry({ attemptCount: lease.attemptCount, error });
    if (invalidArtifact.regenerate) {
      await recordInvalidArtifactAttempt({ runId, stage, inputHash, error, attempt: lease.attemptCount });
      await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", evidence: { message, retryable: true, attempt: lease.attemptCount, validationError: message } });
      await setRunStatus(runId, "queued", { stage });
      await appendRunEvent(runId, stage, "status", `${stage} produced an invalid artifact and will regenerate.`, { attempt: lease.attemptCount, validationError: message });
      await scheduleStage(runId, stage, `validation-${invalidArtifact.nextAttempt}`);
      return;
    }
    if (isArtifactValidationFailure(error)) await recordInvalidArtifactAttempt({ runId, stage, inputHash, error, attempt: lease.attemptCount });
    await checkpointStage({ runId, stage, inputHash, leaseToken: lease.leaseToken, leaseOwner: owner, outcome: "failed", evidence: { message, stageInputHash: inputHash } });
    await setRunStatus(runId, "failed", { stage, failureCode: "STAGE_FAILED", failureMessage: message });
    await appendRunEvent(runId, stage, "stage_failed", `${stage} failed: ${message}`, {});
    // Terminal validation and configuration failures are persisted outcomes. They
    // must not consume BullMQ retries; only classified transient provider failures
    // are rethrown above.
    return;
  } finally {
    // `stop` is idempotent.  Suppress its lease-loss error here because the
    // success/catch paths above make the ownership decision explicitly.
    await leaseHeartbeat.stop().catch(() => undefined);
  }
};
