import { describe, expect, it } from "vitest";
import { asProviderError, ProviderError } from "../src/errors.ts";

const response = (status: number) => new Response(null, { status });

describe("provider failure classification", () => {
  it("classifies rate limits and server errors as retryable", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503]) {
      const error = asProviderError("openai", response(status), "temporary");
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.retryable, String(status)).toBe(true);
      expect(error.status).toBe(status);
    }
  });

  it("classifies authentication, quota, and malformed requests as permanent", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(asProviderError("gemini", response(status), "permanent").retryable, String(status)).toBe(false);
    }
  });

  it("never leaks more than a bounded slice of the provider body", () => {
    const error = asProviderError("openai", response(500), "x".repeat(5_000));
    expect(error.message.length).toBeLessThan(600);
  });
});
