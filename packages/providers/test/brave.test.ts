import { describe, expect, it } from "vitest";
import type { ModelRoute } from "@upcraft/contracts";
import {
  BRAVE_BACKOFF_MS,
  BRAVE_RETRY_LADDER,
  BraveResearchUnavailableError,
  broadenQuery,
  parseBraveGrounding,
  runBraveResearch,
} from "../src/brave.ts";
import { BraveCredentialError, BraveSchemaDriftError, BraveTerminalError, McpTransportError, classifyBraveFailureText, flattenToolError, type BraveMcpClient } from "../src/brave-mcp.ts";
import { estimateCostMicrounits } from "../src/model-config.ts";
import { requiredCapabilitiesFor } from "../src/capabilities.ts";

const route: ModelRoute = {
  capability: "research-web",
  provider: "brave",
  model: "llm-context/v1",
  modelRef: "brave/llm-context/v1",
  configVersion: "model-config/v1",
  resolvedFrom: "default",
  pricingVersion: "pricing/2026-09-23",
};

const snippet = "Photosynthesis converts light energy into chemical energy stored in glucose. ".repeat(3).trim();
const payload = { grounding: { generic: [{ url: "https://www.example.edu/p", title: "P", snippets: [snippet] }] } };
const noSleep = async () => {};

type Stub = {
  start: () => Promise<void>;
  assertLlmContextTool: () => Promise<string[]>;
  callLlmContext: (params: Record<string, unknown>, timeoutMs: number) => Promise<{ payload: Record<string, unknown>; text: string }>;
  close: () => Promise<void>;
};
const asClient = (stub: Stub) => stub as unknown as BraveMcpClient;

describe("Brave failure classification (status embedded in flattened text)", () => {
  it("treats auth and quota as terminal", () => {
    expect(classifyBraveFailureText("401 Unauthorized\n{}")).toMatchObject({ retryable: false, code: "BRAVE_401" });
    expect(classifyBraveFailureText("403 Forbidden")).toMatchObject({ retryable: false, code: "BRAVE_403" });
    expect(classifyBraveFailureText("Invalid API Key")).toMatchObject({ retryable: false, code: "BRAVE_INVALID_API_KEY" });
    expect(classifyBraveFailureText("quota exceeded")).toMatchObject({ retryable: false, kind: "terminal" });
  });

  it("treats rate limits, server errors, and malformed payloads as retryable", () => {
    expect(classifyBraveFailureText("429 Too Many Requests")).toMatchObject({ retryable: true, code: "BRAVE_429" });
    expect(classifyBraveFailureText("500 Internal Server Error")).toMatchObject({ retryable: true, code: "BRAVE_5XX" });
    expect(classifyBraveFailureText("unexpected body")).toMatchObject({ retryable: true, code: "BRAVE_MALFORMED" });
  });

  it("flattens content and structuredContent for classification", () => {
    expect(flattenToolError({ content: [{ text: "401 Unauthorized" }], structuredContent: { status: 401 } })).toContain("401 Unauthorized");
  });
});

describe("Brave grounding parsing", () => {
  it("keeps generic entries, ignores poi/map, and drops malformed ones", () => {
    const parsed = parseBraveGrounding({
      grounding: { generic: [{ url: "https://a.example.edu/x", title: "A", snippets: ["one", 2, "two"] }, { title: "no url" }], poi: { results: [{ url: "https://poi" }] } },
    });
    expect(parsed).toEqual([{ url: "https://a.example.edu/x", title: "A", snippets: ["one", "two"] }]);
    expect(parseBraveGrounding(undefined)).toEqual([]);
  });
});

describe("Brave retry ladder", () => {
  it("keeps five attempts with the compressed timeouts and threshold order", () => {
    expect(BRAVE_RETRY_LADDER).toHaveLength(5);
    expect(BRAVE_RETRY_LADDER.map((step) => step.timeoutMs)).toEqual([10_000, 15_000, 20_000, 35_000, 40_000]);
    expect(BRAVE_RETRY_LADDER.map((step) => step.params.context_threshold_mode)).toEqual(["strict", "balanced", "lenient", "disabled", "disabled"]);
    expect(BRAVE_RETRY_LADDER[4]!.broaden).toBe(true);
    expect([...BRAVE_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(broadenQuery("How does photosynthesis work in plants?")).toBe("photosynthesis plants");
  });

  it("returns on the first attempt with usable grounding", async () => {
    const client = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => ({ payload, text: "" }), close: async () => {} });
    const result = await runBraveResearch(route, { query: "photosynthesis", client, sleep: noSleep });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ thresholdMode: "strict", timeoutMs: 10_000, broadened: false });
    expect(result.sources).toHaveLength(1);
  });

  it("exhausts all five attempts on empty grounding with a client-safe error", async () => {
    const client = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => ({ payload: { grounding: { generic: [] } }, text: "" }), close: async () => {} });
    await expect(runBraveResearch(route, { query: "x", client, sleep: noSleep })).rejects.toMatchObject({ message: "Something went wrong. Please try again later.", code: "BRAVE_EXHAUSTED" });
  });

  it("never retries a terminal auth failure", async () => {
    let calls = 0;
    const client = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => { calls += 1; throw new BraveTerminalError("401 Unauthorized", "BRAVE_401"); }, close: async () => {} });
    await expect(runBraveResearch(route, { query: "x", client, sleep: noSleep })).rejects.toBeInstanceOf(BraveResearchUnavailableError);
    expect(calls).toBe(1);
  });

  it("surfaces schema drift and startup credential failures", async () => {
    const drift = asClient({ start: async () => {}, assertLlmContextTool: async () => { throw new BraveSchemaDriftError("missing"); }, callLlmContext: async () => ({ payload, text: "" }), close: async () => {} });
    await expect(runBraveResearch(route, { query: "x", client: drift, sleep: noSleep })).rejects.toBeInstanceOf(BraveSchemaDriftError);
    const credential = asClient({ start: async () => { throw new BraveCredentialError("no key"); }, assertLlmContextTool: async () => [], callLlmContext: async () => ({ payload, text: "" }), close: async () => {} });
    await expect(runBraveResearch(route, { query: "x", client: credential, sleep: noSleep })).rejects.toBeInstanceOf(BraveCredentialError);
    expect(new McpTransportError("timeout", "x").retryable).toBe(true);
  });
});

describe("capability preflight required set", () => {
  it("requires web research only for source-less runs", () => {
    expect(requiredCapabilitiesFor(0)).toContain("research");
    expect(requiredCapabilitiesFor(1)).not.toContain("research");
  });
});

describe("Brave pricing", () => {  it("prices per query when a rate is configured and stays unpriced otherwise", () => {
    expect(estimateCostMicrounits("brave", { queries: 3 }, { BRAVE_COST_MICRODOLLARS_PER_QUERY: "5" })).toBe(15);
    expect(estimateCostMicrounits("brave", {}, { BRAVE_COST_MICRODOLLARS_PER_QUERY: "5" })).toBe(5);
    expect(estimateCostMicrounits("brave", { queries: 3 }, {})).toBeUndefined();
  });
});
