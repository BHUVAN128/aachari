import type { ModelRoute } from "@upcraft/contracts";
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

const usageFrom = (payload: Record<string, unknown>, fallbackModel: string, inputCharacters: number, outputCharacters: number) => {
  const usage = payload.usage as Record<string, unknown> | undefined;
  const details = usage?.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage?.output_tokens_details as Record<string, unknown> | undefined;
  return {
    requestId: typeof payload.id === "string" ? payload.id : undefined,
    model: typeof payload.model === "string" ? payload.model : fallbackModel,
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
    cachedInputTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
    reasoningTokens: typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined,
    inputCharacters,
    outputCharacters,
  };
};

const callResponses = async (route: ModelRoute, body: { input: unknown; text: Record<string, unknown>; cacheSuffix: string }) => {
  const model = route.model;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${required("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt_cache_key: `upcraft:${model}:${body.cacheSuffix}:v2`,
      input: body.input,
      text: body.text,
    }),
  });
  if (!response.ok) throw asProviderError("openai", response, await response.text());
  return { payload: await response.json() as Record<string, unknown>, requestId: response.headers.get("x-request-id") ?? undefined };
};

export const generateStructuredText = async <T>(
  route: ModelRoute,
  params: { prompt: string; schemaName: string; jsonSchema: Record<string, unknown> },
): Promise<ProviderResult<T>> => {
  const { payload, requestId } = await callResponses(route, {
    input: [{ role: "user", content: [{ type: "input_text", text: params.prompt }] }],
    text: { format: { type: "json_schema", name: params.schemaName, strict: true, schema: params.jsonSchema } },
    cacheSuffix: params.schemaName,
  });
  const outputText = extractText(payload);
  const usage = usageFrom(payload, route.model, params.prompt.length, outputText.length);
  return { value: JSON.parse(outputText) as T, usage: { ...usage, requestId: usage.requestId ?? requestId } };
};

/**
 * Schema-free JSON transport, used only when the independent verifier falls
 * back to OpenAI. The stage still validates the returned artifact against its
 * typed contract; this is not a strict structured-output guarantee.
 */
export const generateJsonText = async (route: ModelRoute, prompt: string): Promise<ProviderResult<Record<string, unknown>>> => {
  const { payload, requestId } = await callResponses(route, {
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    text: { format: { type: "json_object" } },
    cacheSuffix: "json-verifier",
  });
  const outputText = extractText(payload);
  const usage = usageFrom(payload, route.model, prompt.length, outputText.length);
  return { value: JSON.parse(outputText) as Record<string, unknown>, usage: { ...usage, requestId: usage.requestId ?? requestId } };
};
