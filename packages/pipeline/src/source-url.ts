/**
 * Source URL policy. URLs are untrusted input: only HTTPS is accepted, redirects
 * must stay HTTPS, and only text-like content types may be extracted. Kept pure
 * so the retrieval gates have deterministic regression coverage.
 */
export const parseHttpsUrl = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only HTTPS source URLs are accepted");
  return url;
};

export const assertHttpsRedirect = (finalUrl: string): URL => {
  const url = new URL(finalUrl);
  if (url.protocol !== "https:") throw new Error("Source redirects must remain HTTPS");
  return url;
};

export const isSupportedSourceContentType = (contentType: string) =>
  contentType.includes("text/") || contentType.includes("html") || contentType.includes("json");
