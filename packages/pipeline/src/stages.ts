import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { ZodError } from "zod";
import {
  ApprovedScriptSchema,
  BlueprintSchema,
  ClaimVerificationSchema,
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
  generateStructuredText,
  getPrivateReadUrl,
  putPrivateObject,
  synthesizeNarration,
  verifyClaims,
  ProviderError,
  type ProviderUsageSnapshot,
} from "@upcraft/providers";
import { renderLesson } from "@upcraft/compositor";
import { appendRunEvent, claimStageLease, checkpointStage, evaluateCostReviewAlert, getRun, setRunStatus, StageLeaseLostError, startStageLeaseHeartbeat } from "./runs.ts";
import { scheduleStage } from "./outbox.ts";
import { assertTelemetrySafe } from "./telemetry.ts";
import { buildSourceEvidenceMap, canonicalNarrationText, contextManifest, projectFactVerificationContext, projectScriptContext, projectVisualContext, sourceEvidenceSegments } from "./context.ts";

type Json = Record<string, unknown>;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textSha = (value: string) => createHash("sha256").update(value).digest("hex");
const factPackJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["fact-pack/v2"] }, claims: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] }, critical: { type: "boolean" } }, required: ["id", "text", "evidence", "critical"] } }, caveats: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] } }, required: ["text"] } } }, required: ["schemaVersion", "claims", "caveats"] } as Record<string, unknown>;
const blueprintJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["lesson-blueprint/v1"] }, objective: { type: "string" }, prerequisites: { type: "array", items: { type: "string" } }, scenes: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, order: { type: "integer" }, purpose: { type: "string" }, claimIds: { type: "array", items: { type: "string" } }, visualBeat: { type: "string" } }, required: ["id", "order", "purpose", "claimIds", "visualBeat"] } } }, required: ["schemaVersion", "objective", "prerequisites", "scenes"] } as Record<string, unknown>;
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
  const url = new URL(source.sourceUrl);
  if (url.protocol !== "https:") throw new Error("Only HTTPS source URLs are accepted");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!response.ok) throw new Error(`Source fetch failed (${response.status})`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") throw new Error("Source redirects must remain HTTPS");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/") && !contentType.includes("html") && !contentType.includes("json")) throw new Error(`Unsupported source content type: ${contentType}`);
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
  const factClaims = FactPackSchema.parse(factPack).claims;
  if (verification.evidence.length !== factClaims.length || new Set(verification.evidence.map((entry) => entry.claimId)).size !== factClaims.length || factClaims.some((claim) => !verification.evidence.some((entry) => entry.claimId === claim.id))) throw new Error("Independent verification did not check every fact-pack claim exactly once");
  for (const entry of verification.evidence) {
    const claim = factClaims.find((candidate) => candidate.id === entry.claimId);
    if (!claim || claim.evidence.sourceId !== entry.sourceId) throw new Error(`Independent verification changed evidence identity for claim ${entry.claimId}`);
    sourceEvidenceSegments(evidenceMap, [{ sourceId: entry.sourceId, sourceHash: claim.evidence.sourceHash, segmentIds: entry.segmentIds }]);
  }
  const unsupported = verification.evidence.filter((entry) => !entry.supported).map((entry) => entry.claimId);
  if (unsupported.length) throw new Error(`Independent verification rejected claims: ${unsupported.join(", ")}`);
  const claimRows = factClaims.map((claim) => ({ runId, sourceId: claim.evidence.sourceId, claim: claim.text, locator: claim.evidence.locator, evidence: claim.evidence, critical: claim.critical, verifiedAt: new Date(), verifierModel: process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.8-flash" }));
  if (claimRows.length && !(await getDb().select({ id: sourceClaims.id }).from(sourceClaims).where(eq(sourceClaims.runId, runId))).length) await getDb().insert(sourceClaims).values(claimRows);
  return saveArtifact({ runId, stage: "fact-verification", role: "fact-verification", schemaVersion: "fact-verification/v2", inputHash: sha(factPack), content: verification });
};

const runBlueprint = async (runId: string) => {
  const factPack = requireContent(await getArtifact(runId, "fact-pack"), "fact-pack");
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const startedAt = Date.now();
  const raw = await generateStructuredText<Json>({ schemaName: "lesson_blueprint", jsonSchema: blueprintJsonSchema, prompt: `${await validationFeedback(runId, "blueprint")}Create an educational lesson blueprint for ${run.title}. Return schemaVersion "lesson-blueprint/v1", objective, prerequisites, scenes [{id,order,purpose,claimIds,visualBeat}]. Each scene must have one meaningful visual beat and only cited claim IDs.\n${JSON.stringify(factPack)}` });
  await recordUsage(runId, "blueprint", "openai", process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra", startedAt, raw.usage, "blueprint/v1", contextManifest("verified-fact-catalog/v1", [{ role: "fact-pack", hash: sha(factPack), chars: JSON.stringify(factPack).length, itemCount: FactPackSchema.parse(factPack).claims.length }]));
  const blueprint = BlueprintSchema.parse(raw.value); const claimIds = new Set(requireContent<{ claims: Array<{ id: string }> }>(await getArtifact(runId, "fact-pack"), "fact-pack").claims.map((claim) => claim.id)); if (blueprint.scenes.some((scene) => scene.claimIds.some((claimId) => !claimIds.has(claimId)))) throw new Error("Blueprint contains a claim reference outside the fact pack");
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
  if (verification.evidence.length !== script.narration.length || new Set(verification.evidence.map((entry) => entry.lineId)).size !== script.narration.length || script.narration.some((line) => !verification.evidence.some((entry) => entry.lineId === line.id))) throw new Error("Independent script verification did not check every script line exactly once");
  if (verification.evidence.some((entry) => !entry.supported || entry.unsupportedClaimIds.length)) throw new Error("Independent script verification rejected unsupported narration");
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

const runAssets = async (runId: string) => {
  const script = ApprovedScriptSchema.parse(requireContent(await getArtifact(runId, "approved-script"), "approved-script"));
  const bible = requireContent<{ palette: string[] }>(await getArtifact(runId, "visual-bible"), "visual-bible");
  const inputHash = sha([script, bible]);
  const existing = await getArtifact(runId, "selected-assets");
  if (existing?.inputHash === inputHash) return existing;
  const sceneLines = [...new Map(script.narration.map((line) => [line.sceneId, line])).values()];
  const assets = await Promise.all(sceneLines.map(async (scene, index) => {
    const role = "diagram-" + scene.sceneId;
    const existingAsset = (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.selected, true))))[0];
    if (existingAsset) return existingAsset;
    const color = bible.palette[index % bible.palette.length];
    if (!color || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Visual bible palette must use six-digit hexadecimal colors");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#09090b"/><path d="M220 ' + (780 - index * 20) + ' C650 ' + (240 + index * 25) + ',1280 ' + (820 - index * 15) + ',1700 ' + (280 + index * 20) + '" fill="none" stroke="' + color + '" stroke-width="24" stroke-linecap="round"/><circle cx="220" cy="' + (780 - index * 20) + '" r="52" fill="#f8fafc"/><circle cx="1700" cy="' + (280 + index * 20) + '" r="52" fill="#f8fafc"/></svg>';
    const object = await putPrivateObject({ key: "runs/" + runId + "/assets/scene-" + scene.sceneId + ".svg", body: svg, contentType: "image/svg+xml" });
    const [asset] = await getDb().insert(mediaAssets).values({ runId, sceneId: scene.sceneId, role, objectKey: object.key, sha256: object.sha256, mimeType: "image/svg+xml", byteSize: object.byteSize, width: 1920, height: 1080, selected: true, provenance: { kind: "typed-svg", sceneId: scene.sceneId, scriptHash: sha(script), optionalIllustration: "omitted" } }).onConflictDoNothing().returning();
    const stableAsset = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.sha256, object.sha256))))[0];
    if (!stableAsset) throw new Error("Selected asset persistence failed");
    return stableAsset;
  }));
  const content = { assetIds: assets.map((asset) => asset.id), composition: "typed-scene-svg", visualBibleHash: sha(bible), optionalIllustration: { choice: "omitted", reason: "The locked visual direction is fully represented by deterministic vector assets." } };
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
    return { sceneId, layoutArtifactId: layoutArtifact.id, startMs: timing.startMs, endMs: timing.endMs, title: blueprintScene.purpose, visualBeat: timing.visualBeat, layers: layout.layers.map((layer) => ({ id: layer.id, kind: "diagram" as const, assetId: asset.id, zIndex: layer.zIndex, bounds: layer.bounds })) };
  });
  const manifest = ProjectManifestSchema.parse({ schemaVersion: "video-manifest/v1", fps: 30, canvas: layoutBundle.canvas, safeArea, narrationAssetId: voiceover.assetId, words: captions.words, captions: captions.cues, scenes });
  return saveArtifact({ runId, stage: "manifest", role: "project-manifest", schemaVersion: manifest.schemaVersion, inputHash: sha([voiceoverArtifact?.sha256, captionsArtifact?.sha256, layoutArtifact?.sha256]), content: manifest });
};

const render = async (runId: string, kind: "preview" | "final") => {
  const [run, manifestArtifact, voiceoverArtifact, assets] = await Promise.all([getRun(runId), getArtifact(runId, "project-manifest"), getArtifact(runId, "voiceover"), getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true)))]);
  if (!run) throw new Error("Run not found");
  const storedManifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const assetUrls = new Map(await Promise.all(assets.map(async (asset) => [asset.id, await getPrivateReadUrl(asset.objectKey, 3_600)] as const)));
  const manifest = ProjectManifestSchema.parse({ ...storedManifest, scenes: storedManifest.scenes.map((scene) => ({ ...scene, layers: scene.layers.map((layer) => ({ ...layer, ...(layer.assetId && assetUrls.get(layer.assetId) ? { assetUrl: assetUrls.get(layer.assetId) } : {}) })) })) });
  const voiceover = requireContent<{ objectKey: string }>(voiceoverArtifact, "voiceover");
  const outputPath = join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId, `${kind}.mp4`);
  await mkdir(join(process.env.RENDER_OUTPUT_DIR ?? ".local/renders", runId), { recursive: true });
  await renderLesson({ title: run.title, manifest, audioUrl: await getPrivateReadUrl(voiceover.objectKey, 3_600), outputPath });
  const bytes = await readFile(outputPath);
  const object = await putPrivateObject({ key: `runs/${runId}/renders/${kind}.mp4`, body: bytes, contentType: "video/mp4" });
  await getDb().insert(renderOutputs).values({ runId, kind, objectKey: object.key, sha256: object.sha256, durationMs: manifest.words.at(-1)?.endMs ?? 0, width: manifest.canvas.width, height: manifest.canvas.height }).onConflictDoUpdate({ target: [renderOutputs.runId, renderOutputs.kind], set: { objectKey: object.key, sha256: object.sha256 } });
  return saveArtifact({ runId, stage: kind === "preview" ? "preview-render" : "final-render", role: `${kind}-render`, schemaVersion: "render-output/v1", inputHash: sha(manifest), content: { objectKey: object.key, sha256: object.sha256, durationMs: manifest.words.at(-1)?.endMs ?? 0 } });
};

const runQa = async (runId: string) => {
  const [captionArtifact, manifestArtifact, previewArtifact, factArtifact, scriptArtifact, layoutArtifact, assets] = await Promise.all([
    getArtifact(runId, "caption-timings"), getArtifact(runId, "project-manifest"), getArtifact(runId, "preview-render"),
    getArtifact(runId, "fact-pack"), getArtifact(runId, "approved-script"), getArtifact(runId, "resolved-layout"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
  ]);
  const captions = requireContent<{ words: WordTiming[]; cues: Array<{ wordIndexes: number[] }> }>(captionArtifact, "caption-timings");
  const manifest = ProjectManifestSchema.parse(requireContent(manifestArtifact, "project-manifest"));
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const issues: Array<{ rule: string; evidence: Record<string, unknown>; remediation: string }> = [];
  const badWords = captions.words.filter((word, index) => word.endMs <= word.startMs || (index > 0 && word.startMs < (captions.words[index - 1]?.endMs ?? 0)));
  if (badWords.length) issues.push({ rule: "caption-monotonicity", evidence: { count: badWords.length }, remediation: "Rebuild caption timings from the validated narration alignment." });
  if (!previewArtifact) issues.push({ rule: "preview-render-present", evidence: {}, remediation: "Render the preview from the locked project manifest." });
  if (!factArtifact || !scriptArtifact || !layoutArtifact || !manifestArtifact) issues.push({ rule: "artifact-completeness", evidence: { missing: ["fact-pack", "approved-script", "resolved-layout", "project-manifest"].filter((role) => ![factArtifact, scriptArtifact, layoutArtifact, manifestArtifact][["fact-pack", "approved-script", "resolved-layout", "project-manifest"].indexOf(role)]) }, remediation: "Restore the missing validated upstream artifact before release." });
  if (!captions.cues.length || captions.cues.some((cue) => cue.wordIndexes.some((index) => index >= captions.words.length))) issues.push({ rule: "caption-index-integrity", evidence: {}, remediation: "Rebuild captions with indexes into the locked word alignment." });
  const scriptSceneCount = new Set(script.narration.map((line) => line.sceneId)).size;
  if (manifest.scenes.length !== scriptSceneCount || manifest.scenes.some((scene) => !assets.some((asset) => asset.id === scene.layers.find((layer) => layer.assetId)?.assetId))) issues.push({ rule: "scene-asset-completeness", evidence: { scenes: manifest.scenes.length, scriptScenes: scriptSceneCount, assets: assets.length }, remediation: "Produce and attach one validated selected asset for every narrated scene." });
  if (issues.length) {
    await getDb().insert(qaFindings).values(issues.map((issue) => ({ runId, rule: issue.rule, severity: "critical" as const, evidence: issue.evidence, remediation: issue.remediation })));
    throw new Error("Release QA failed: " + issues.map((issue) => issue.rule).join(", "));
  }
  return saveArtifact({ runId, stage: "qa", role: "qa-report", schemaVersion: "qa-report/v1", inputHash: sha([manifest, captions]), content: { passed: true, checks: ["schema", "artifact-completeness", "caption-monotonicity", "caption-index-integrity", "scene-asset-completeness", "preview-render-present"] } });
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
  assets: ["approved-script", "visual-bible"],
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
      const automatic = run.domain === "standard" && ["school", "college"].includes(run.snapshot.audienceCategory);
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
