import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStructuredText } from "../src/openai.ts";

describe("provider usage accounting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves provider-reported token and cache counters", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "resp_test",
      model: "gpt-test",
      output_text: '{"ok":true}',
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 14, output_tokens_details: { reasoning_tokens: 4 } },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await generateStructuredText<{ ok: boolean }>({
      schemaName: "usage_test",
      jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      prompt: "short prompt",
      model: "gpt-test",
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ requestId: "resp_test", model: "gpt-test", inputTokens: 120, cachedInputTokens: 80, outputTokens: 14, reasoningTokens: 4, inputCharacters: 12 });
  });
});
