import { describe, expect, it, vi } from "vitest";
import { ProviderError, resolveModelRoute } from "@upcraft/providers";
import { resolveStageRoute } from "../src/routing.ts";
import { withFallback } from "../src/fallback.ts";

const transient = (code = "GEMINI_503") => new ProviderError("temporary provider failure", { code, retryable: true, status: 503 });
const permanent = (code = "GEMINI_401") => new ProviderError("authentication failed", { code, retryable: false, status: 401 });
const validation = () => new SyntaxError("malformed JSON");

describe("bounded provider fallback", () => {
  it("falls back once to the declared route on a classified transient failure and records the failed attempt", async () => {
    const route = resolveModelRoute("fact-verification");
    const attempts: string[] = [];
    const recorded: Array<{ provider: string; model: string }> = [];
    const result = await withFallback(
      route,
      async (attemptRoute) => {
        attempts.push(attemptRoute.modelRef);
        if (attemptRoute.modelRef === route.modelRef) throw transient();
        return attemptRoute.modelRef;
      },
      async (failedRoute) => { recorded.push({ provider: failedRoute.provider, model: failedRoute.model }); },
    );
    expect(result.route).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", resolvedFrom: "fallback" });
    expect(result.value).toBe("openai/gpt-5.6-terra");
    expect(attempts).toEqual(["gemini/gemini-3.8-flash", "openai/gpt-5.6-terra"]);
    // The failure is attributed to the route that failed, not the fallback.
    expect(recorded).toEqual([{ provider: "gemini", model: "gemini-3.8-flash" }]);
  });

  it("never falls back for an authentication or quota-class permanent failure", async () => {
    const route = resolveModelRoute("fact-verification");
    const attempt = vi.fn(async () => { throw permanent(); });
    const record = vi.fn(async () => undefined);
    await expect(withFallback(route, attempt, record)).rejects.toBeInstanceOf(ProviderError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("never falls back for a schema/validation failure", async () => {
    const route = resolveModelRoute("planning");
    const attempt = vi.fn(async () => { throw validation(); });
    const record = vi.fn(async () => undefined);
    await expect(withFallback(route, attempt, record)).rejects.toBeInstanceOf(SyntaxError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("rethrows when the capability declares no fallback route", async () => {
    const route = resolveModelRoute("illustration");
    const attempt = vi.fn(async () => { throw transient("GEMINI_503"); });
    await expect(withFallback(route, attempt, vi.fn(async () => undefined))).rejects.toBeInstanceOf(ProviderError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one bounded hop: a fallback failure is not retried again", async () => {
    const route = resolveModelRoute("planning");
    const attempt = vi.fn(async () => { throw transient("OPENAI_503"); });
    await expect(withFallback(route, attempt, vi.fn(async () => undefined))).rejects.toBeInstanceOf(ProviderError);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("resolves deterministic stages without a model route", () => {
    expect(resolveStageRoute("manifest")).toBeUndefined();
    expect(resolveStageRoute("preview-render")).toBeUndefined();
    expect(resolveStageRoute("research")).toMatchObject({ provider: "openai" });
  });
});