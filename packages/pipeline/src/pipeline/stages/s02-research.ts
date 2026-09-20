import { eq } from "drizzle-orm";
import { FactPackSchema } from "@upcraft/contracts";
import { getDb, sourceDocuments } from "@upcraft/db";
import { generateStructuredText } from "@upcraft/providers";
import { saveArtifact, validationFeedback } from "../../artifacts/store.ts";
import { sha, textSha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage } from "../../usage.ts";
import { assertHttpsRedirect, isSupportedSourceContentType, parseHttpsUrl } from "../../source-url.ts";
import { buildSourceEvidenceMap, contextManifest, sourceEvidenceSegments } from "../../context.ts";
import { factPackJsonSchema } from "../../prompts/fact-pack.ts";
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

/** §3 M2 Research & fact pack — retrieve, segment, and emit a grounded fact pack. */
export const runResearch = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
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
  const route = ctx.route("research")!;
  const raw = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, {
    schemaName: "fact_pack",
    jsonSchema: factPackJsonSchema,
    prompt: `${await validationFeedback(runId, "research")}Create a source-grounded fact pack. Use only the supplied source segments. Return JSON with schemaVersion "fact-pack/v2", claims [{id, text, evidence {sourceId, sourceHash, segmentIds, locator}, critical}], and caveats [{text, evidence?}]. Every claim must cite one or more supplied segment IDs. Do not quote or reproduce source text in the output.\n\n${sourceContext}`,
  }), async (failedRoute, error) => {
    await recordUsage(runId, "research", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "research/v2", { projection: "source-full-segmented/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "research", raw.route.provider, raw.route.model, startedAt, raw.value.usage, "research/v2", contextManifest("source-full-segmented/v1", [{ role: "source-evidence-map", hash: evidenceMapArtifact.sha256 ?? sha(evidenceMap), chars: sourceContext.length, itemCount: evidenceMap.sources.reduce((sum, source) => sum + source.segments.length, 0) }]));
  const factPack = FactPackSchema.parse(raw.value.value);
  for (const claim of factPack.claims) sourceEvidenceSegments(evidenceMap, [claim.evidence]);
  for (const caveat of factPack.caveats) if (caveat.evidence) sourceEvidenceSegments(evidenceMap, [caveat.evidence]);
  return saveArtifact({ runId, stage: "research", role: "fact-pack", schemaVersion: factPack.schemaVersion, inputHash: sha(sources.map((source) => source.sha256)), content: factPack });
};