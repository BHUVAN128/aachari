import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRoute } from "@upcraft/contracts";
import { searchGroundedText } from "../src/gemini.ts";
import { researchForCapability, researchWithRoute } from "../src/dispatch.ts";

const route: ModelRoute = {
  capability: "research-web",
  provider: "gemini",
  model: "gemini-3.8-flash",
  modelRef: "gemini/gemini-3.8-flash",
  configVersion: "model-config/v1",
  resolvedFrom: "default",
  pricingVersion: "pricing/2026-09-17",
};

const jsonResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("Gemini web-grounded research transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  it("sends the google_search tool, returns JSON, and reports usage", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {
      responseId: "request-1",
      candidates: [{ content: { parts: [{ text: JSON.stringify({ schemaVersion: "research-web/v1", sources: [{ url: "https://www.example.edu/photosynthesis", title: "Photosynthesis", reason: "authoritative reference" }] }) }] } }],
      usageMetadata: { promptTokenCount: 42, cachedContentTokenCount: 5, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchGroundedText(route, "find authoritative sources");

    expect(result.value).toMatchObject({ schemaVersion: "research-web/v1" });
    expect(result.usage).toMatchObject({ requestId: "request-1", model: "gemini-3.8-flash", inputTokens: 42, cachedInputTokens: 5, outputTokens: 7, reasoningTokens: 3 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("gemini-3.8-flash");
  });

  it("throws when the response has no JSON text", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { candidates: [{ content: { parts: [] } }] })));
    await expect(searchGroundedText(route, "prompt")).rejects.toThrow(/web-search response did not include JSON text/);
  });

  it("dispatches researchForCapability to the gemini search transport when rerouted by env", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    const fetchMock = vi.fn(async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await researchForCapability("research-web", "prompt", { GEMINI_API_KEY: "env-key", RESEARCH_WEB_MODEL: "gemini/gemini-3.8-flash" });
    expect(result.value).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider with no web-research transport", async () => {
    await expect(researchWithRoute({ ...route, provider: "elevenlabs", model: "voice" }, "prompt")).rejects.toThrow(/No web-research transport/);
  });
});
