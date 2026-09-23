import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { FactPackSchema, type ModelRoute } from "@upcraft/contracts";
import { getDb, sourceDocuments } from "@upcraft/db";
import { generateStructuredText, researchWithRoute, resolveModelRoute, runBraveResearch } from "@upcraft/providers";
import { saveArtifact, validationFeedback } from "../../artifacts/store.ts";
import { sha, textSha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage } from "../../usage.ts";
import { assertHttpsRedirect, isSupportedSourceContentType, parseHttpsUrl } from "../../source-url.ts";
import { assembleBraveDocuments, isAcceptableWebSource, normalizeHttpsUrl, parseWebResearchSources, WEB_SOURCE_MAX_SOURCES } from "../../web-research.ts";
import { buildSourceEvidenceMap, contextManifest, sourceEvidenceSegments } from "../../context.ts";
import { factPackJsonSchema } from "../../prompts/fact-pack.ts";
import { getRun } from "../../runs.ts";
import type { StageContext } from "../context.ts";

type Json = Record<string, unknown>;

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

/**
 * Brave path (source-less runs). The official `brave_llm_context` tool already
 * returns per-URL snippets joined into citable documents, so the retrieved text
 * is persisted directly with full provenance instead of re-fetching each page.
 * Every ladder attempt — success or failure — is written to the usage ledger.
 */
const gatherBraveSources = async (runId: string, route: ModelRoute): Promise<number> => {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const research = await runBraveResearch(route, {
    query: `${run.title} explained for ${run.snapshot.learningLevel}`,
    onAttempt: async (record) => {
      await recordUsage(runId, "research", route.provider, route.model, Date.now() - record.latencyMs, { model: route.model, queries: 1 }, "research-web/v1", { projection: "brave-llm-context/v1", attempt: record.attempt, thresholdMode: record.thresholdMode, broadened: record.broadened, timeoutMs: record.timeoutMs }, record.outcome, record.errorCode ?? undefined);
    },
  });
  const documents = assembleBraveDocuments(research.sources);
  if (!documents.length) throw new Error("Web research found no usable authoritative sources");
  for (const document of documents) {
    await db.insert(sourceDocuments).values({
      id: randomUUID(),
      runId,
      kind: "url",
      originalName: document.originalName,
      sourceUrl: document.sourceUrl,
      retrievedUrl: document.retrievedUrl,
      retrievalStatus: "retrieved",
      sourceByteSize: document.byteSize,
      sha256: document.sha256,
      sourceBytesSha256: document.sourceBytesSha256,
      mimeType: document.mimeType,
      extractedText: document.extractedText,
      retrievedAt: new Date(),
    });
  }
  return documents.length;
};

/**
 * Web-research fallback: when the run was created with no user-supplied source,
 * the system (not the user) supplies authoritative sources via the grounded
 * research-web route. Returned rows become ordinary `source_documents` with full
 * provenance so the locked-source/evidence-map architecture applies unchanged.
 */
const gatherWebSources = async (ctx: StageContext, runId: string): Promise<number> => {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const startedAt = Date.now();
  const route = resolveModelRoute("research-web");
  if (route.provider === "brave") return gatherBraveSources(runId, route);
  const raw = await withFallback(route, async (attemptRoute) => researchWithRoute(attemptRoute, `Find 2-4 authoritative, current web pages that teach the topic "${run.title}" for ${run.snapshot.learningLevel} (${run.snapshot.audienceCategory} audience) in ${run.snapshot.language}. Return JSON with schemaVersion "research-web/v1" and sources [{url, title, reason}]. Prefer stable .gov/.edu or recognized educational references over blogs. Every url must be a complete https:// URL.`), async (failedRoute, error) => {
    await recordUsage(runId, "research", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "research-web/v1", { projection: "web-source-discovery/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "research", raw.route.provider, raw.route.model, startedAt, raw.value.usage, "research-web/v1", contextManifest("web-source-discovery/v1", []));
  const discovered = parseWebResearchSources(raw.value.value);
  type FetchedWebSource = { originalName: string; sourceUrl: string; retrievedUrl: string; byteSize: number; sha256: string; sourceBytesSha256: string; mimeType: string; extractedText: string };
  const seen = new Set<string>();
  const fetched: FetchedWebSource[] = [];
  for (const candidate of discovered) {
    const normalized = normalizeHttpsUrl(candidate.url);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    try {
      const response = await fetch(normalized.url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!response.ok) continue;
      const finalUrl = assertHttpsRedirect(response.url);
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const byteSize = Buffer.byteLength(body, "utf8");
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!isAcceptableWebSource({ contentType, textLength: text.length, byteSize })) continue;
      fetched.push({
        originalName: candidate.url,
        sourceUrl: candidate.url,
        retrievedUrl: finalUrl.toString(),
        byteSize,
        sha256: textSha(text),
        sourceBytesSha256: textSha(body),
        mimeType: contentType,
        extractedText: text,
      });
    } catch { /* skip unreachable or malformed page */ }
  }
  if (!fetched.length) throw new Error("Web research found no usable authoritative sources");
  for (const source of fetched.slice(0, WEB_SOURCE_MAX_SOURCES)) {
    await db.insert(sourceDocuments).values({
      id: randomUUID(),
      runId,
      kind: "url",
      originalName: source.originalName,
      sourceUrl: source.sourceUrl,
      retrievedUrl: source.retrievedUrl,
      retrievalStatus: "retrieved",
      sourceByteSize: source.byteSize,
      sha256: source.sha256,
      sourceBytesSha256: source.sourceBytesSha256,
      mimeType: source.mimeType,
      extractedText: source.extractedText,
      retrievedAt: new Date(),
    });
  }
  return fetched.slice(0, WEB_SOURCE_MAX_SOURCES).length;
};

/** §3 M2 Research & fact pack — retrieve, segment, and emit a grounded fact pack. */
export const runResearch = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const db = getDb();
  let sources = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  if (!sources.length) {
    await gatherWebSources(ctx, runId);
    sources = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  }
  if (!sources.length) throw new Error("Research requires at least one source document");
  await Promise.all(sources.map(async (source) => {
    const resolved = await resolveSourceText(source);
    await db.update(sourceDocuments).set({
      extractedText: source.extractedText ?? resolved.text,
      sha256: source.extractedText ? source.sha256 : textSha(resolved.text),
      sourceBytesSha256: source.extractedText ? source.sourceBytesSha256 : resolved.rawSha256,
      retrievedAt: source.retrievedAt ?? new Date(),
      retrievedUrl: source.retrievedUrl ?? resolved.retrievedUrl,
      retrievalStatus: source.retrievalStatus === "retrieved" ? "retrieved" : resolved.retrievalStatus,
      sourceByteSize: source.sourceByteSize ?? resolved.byteSize,
      mimeType: source.extractedText ? source.mimeType : resolved.contentType,
    }).where(eq(sourceDocuments.id, source.id));
  }));
  const lockedSources = await db.select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
  const evidenceMap = buildSourceEvidenceMap(lockedSources);
  const evidenceMapArtifact = await saveArtifact({ runId, stage: "research", role: "source-evidence-map", schemaVersion: evidenceMap.schemaVersion, inputHash: sha(lockedSources.map((source) => source.sha256)), content: evidenceMap, provenance: { provider: "deterministic", model: "source-segmentation/v1" } });
  const sourceContext = evidenceMap.sources.map((source) => `SOURCE ${source.sourceId} HASH ${source.sourceHash}\n${source.segments.map((segment) => `SEGMENT ${segment.id} [${segment.startOffset}:${segment.endOffset}]\n${segment.text}`).join("\n")}`).join("\n\n");
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const snapshotProjection = `Learner level: ${run.snapshot.learningLevel}\nAudience: ${run.snapshot.audienceCategory}\nLanguage: ${run.snapshot.language}\n`;
  const startedAt = Date.now();
  const route = ctx.route("research")!;
  const raw = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, {
    schemaName: "fact_pack",
    jsonSchema: factPackJsonSchema,
    prompt: `${await validationFeedback(runId, "research")}Create a source-grounded fact pack. Use only the supplied source segments. ${snapshotProjection}Return JSON with schemaVersion "fact-pack/v2", claims [{id, text, evidence {sourceId, sourceHash, segmentIds, locator}, critical}], and caveats [{text, evidence?}]. Every claim must cite one or more supplied segment IDs. Do not quote or reproduce source text in the output.\n\n${sourceContext}`,
  }), async (failedRoute, error) => {
    await recordUsage(runId, "research", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "research/v2", { projection: "source-full-segmented/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "research", raw.route.provider, raw.route.model, startedAt, raw.value.usage, "research/v2", contextManifest("source-full-segmented/v1", [{ role: "source-evidence-map", hash: evidenceMapArtifact.sha256 ?? sha(evidenceMap), chars: sourceContext.length, itemCount: evidenceMap.sources.reduce((sum, source) => sum + source.segments.length, 0) }]));
  const factPack = FactPackSchema.parse(raw.value.value);
  for (const claim of factPack.claims) sourceEvidenceSegments(evidenceMap, [claim.evidence]);
  for (const caveat of factPack.caveats) if (caveat.evidence) sourceEvidenceSegments(evidenceMap, [caveat.evidence]);
  return saveArtifact({ runId, stage: "research", role: "fact-pack", schemaVersion: factPack.schemaVersion, inputHash: sha(sources.map((source) => source.sha256)), content: factPack });
};