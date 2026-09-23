import { createHash } from "node:crypto";
import type { BraveGroundingSource } from "@upcraft/providers";
import { isSupportedSourceContentType, parseHttpsUrl } from "./source-url.ts";

/**
 * Deterministic web-research policy. The `research-web` model response and every
 * fetched page are untrusted input: only HTTPS URLs are accepted, pages must have
 * a text-like content type, a usable minimum text length, and stay inside the
 * 1 MB extraction limit. Kept pure and dependency-free so the web-source
 * provenance gate has deterministic regression coverage.
 */
export const WEB_SOURCE_MIN_TEXT_LENGTH = 200;
export const WEB_SOURCE_MAX_BYTES = 1_000_000;
export const WEB_SOURCE_MAX_SOURCES = 4;

export type WebResearchSource = { url: string; title: string; reason: string };

/** Parses the research-web model response; malformed entries are dropped, not trusted. */
export const parseWebResearchSources = (payload: unknown): WebResearchSource[] => {
  if (!payload || typeof payload !== "object") return [];
  const sources = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { url, title, reason } = entry as { url?: unknown; title?: unknown; reason?: unknown };
    if (typeof url !== "string" || typeof title !== "string" || typeof reason !== "string") return [];
    return [{ url, title, reason }];
  });
};

/** Normalizes an HTTPS URL to a stable dedupe key; undefined for non-HTTPS or malformed URLs. */
export const normalizeHttpsUrl = (raw: string): { url: string; key: string } | undefined => {
  if (!raw.toLowerCase().startsWith("https://")) return undefined;
  try {
    const url = parseHttpsUrl(raw);
    return { url: raw, key: `${url.host}${url.pathname}`.replace(/\/+$/, "") };
  } catch {
    return undefined;
  }
};

/** Deterministic source-quality check applied before a fetched page may become a locked source. */
export const isAcceptableWebSource = (params: { contentType: string; textLength: number; byteSize: number }): boolean =>
  isSupportedSourceContentType(params.contentType) && params.textLength >= WEB_SOURCE_MIN_TEXT_LENGTH && params.byteSize <= WEB_SOURCE_MAX_BYTES;

/**
 * Brave LLM Context sources. Brave already groups snippets per URL, so a document
 * is the lossless join of its snippets — no second fetch and no re-parsing of an
 * untrusted page. The same untrusted-input rules apply: HTTPS only, a minimum
 * snippet length, and normalized-URL dedupe.
 */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const joinBraveSnippets = (snippets: readonly string[]): string => snippets.join(" ").replace(/\s+/g, " ").trim();

export const isAcceptableBraveSource = (source: Pick<BraveGroundingSource, "url" | "snippets">, minText: number = WEB_SOURCE_MIN_TEXT_LENGTH): boolean =>
  normalizeHttpsUrl(source.url) !== undefined && joinBraveSnippets(source.snippets).length >= minText;

export type BraveDocument = {
  originalName: string;
  sourceUrl: string;
  retrievedUrl: string;
  byteSize: number;
  sha256: string;
  sourceBytesSha256: string;
  mimeType: string;
  extractedText: string;
};

/**
 * Joins Brave snippets per URL into citable documents, dropping insecure,
 * too-short, duplicate, and oversized entries. Provenance covers both the
 * extracted text hash and the raw snippet payload hash per URL.
 */
export const assembleBraveDocuments = (sources: ReadonlyArray<Pick<BraveGroundingSource, "url" | "snippets">>, max: number = WEB_SOURCE_MAX_SOURCES): BraveDocument[] => {
  const seen = new Set<string>();
  const documents: BraveDocument[] = [];
  for (const source of sources) {
    if (!isAcceptableBraveSource(source)) continue;
    const normalized = normalizeHttpsUrl(source.url);
    if (!normalized || seen.has(normalized.key)) continue;
    const text = joinBraveSnippets(source.snippets);
    const byteSize = Buffer.byteLength(text, "utf8");
    if (byteSize > WEB_SOURCE_MAX_BYTES) continue;
    seen.add(normalized.key);
    documents.push({
      originalName: source.url,
      sourceUrl: source.url,
      retrievedUrl: source.url,
      byteSize,
      sha256: sha256(text),
      sourceBytesSha256: sha256(source.snippets.join("\n")),
      mimeType: "text/plain",
      extractedText: text,
    });
  }
  return documents.slice(0, max);
};
