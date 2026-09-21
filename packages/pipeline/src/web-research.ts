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
