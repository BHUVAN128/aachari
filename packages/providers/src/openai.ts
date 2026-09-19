import { asProviderError } from "./errors.ts";
import type { ProviderResult } from "./usage.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const extractText = (payload: Record<string, unknown>) => {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  });
  const text = parts.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "output_text") as { text?: unknown } | undefined;
  if (typeof text?.text === "string") return text.text;
  throw new Error("OpenAI response did not include output text");
};

export const generateStructuredText = async <T>(params: { prompt: string; schemaName: string; jsonSchema: Record<string, unknown>; model?: string }): Promise<ProviderResult<T>> => {
  const model = params.model ?? process.env.OPENAI_PLANNING_MODEL ?? "gpt-5.6-terra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${required("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt_cache_key: `upcraft:${model}:${params.schemaName}:v2`,
      input: [{ role: "user", content: [{ type: "input_text", text: params.prompt }] }],
      text: { format: { type: "json_schema", name: params.schemaName, strict: true, schema: params.jsonSchema } },
    }),
  });
  if (!response.ok) throw asProviderError("openai", response, await response.text());
  const payload = await response.json() as Record<string, unknown>;
  const outputText = extractText(payload);
  const usage = payload.usage as Record<string, unknown> | undefined;
  const details = usage?.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage?.output_tokens_details as Record<string, unknown> | undefined;
  return {
    value: JSON.parse(outputText) as T,
    usage: {
      requestId: typeof payload.id === "string" ? payload.id : response.headers.get("x-request-id") ?? undefined,
      model: typeof payload.model === "string" ? payload.model : model,
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
      cachedInputTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
      reasoningTokens: typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined,
      inputCharacters: params.prompt.length,
      outputCharacters: outputText.length,
    },
  };
};
