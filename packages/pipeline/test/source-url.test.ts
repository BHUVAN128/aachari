import { describe, expect, it } from "vitest";
import { assertHttpsRedirect, isSupportedSourceContentType, parseHttpsUrl } from "../src/source-url.ts";

describe("source URL retrieval policy", () => {
  it("accepts only HTTPS source URLs", () => {
    expect(parseHttpsUrl("https://example.com/lesson").protocol).toBe("https:");
    expect(() => parseHttpsUrl("http://example.com/lesson")).toThrow("Only HTTPS");
    expect(() => parseHttpsUrl("ftp://example.com/lesson")).toThrow("Only HTTPS");
  });

  it("rejects a redirect that downgrades to HTTP", () => {
    expect(assertHttpsRedirect("https://example.com/final").protocol).toBe("https:");
    expect(() => assertHttpsRedirect("http://example.com/final")).toThrow("redirects must remain HTTPS");
  });

  it("accepts only text-like content types", () => {
    expect(isSupportedSourceContentType("text/html; charset=utf-8")).toBe(true);
    expect(isSupportedSourceContentType("application/json")).toBe(true);
    expect(isSupportedSourceContentType("application/pdf")).toBe(false);
    expect(isSupportedSourceContentType("image/png")).toBe(false);
  });
});
