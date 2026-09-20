import type { ModelRoute } from "@upcraft/contracts";
import { asProviderError } from "./errors.ts";
import type { ProviderResult } from "./usage.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const generate = async (model: string, body: Record<string, unknown>) => {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw asProviderError("gemini", response, await response.text());
  return await response.json() as { responseId?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } }>; usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
};

export const verifyClaims = async (route: ModelRoute, prompt: string): Promise<ProviderResult<Record<string, unknown>>> => {
  const model = route.model;
  const result = await generate(model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  const text = result.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
  if (!text) throw new Error("Gemini verification response did not include JSON text");
  return {
    value: JSON.parse(text) as Record<string, unknown>,
    usage: {
      requestId: result.responseId,
      model,
      inputTokens: result.usageMetadata?.promptTokenCount,
      cachedInputTokens: result.usageMetadata?.cachedContentTokenCount,
      outputTokens: result.usageMetadata?.candidatesTokenCount,
      reasoningTokens: result.usageMetadata?.thoughtsTokenCount,
      inputCharacters: prompt.length,
      outputCharacters: text.length,
    },
  };
};

export const generateIllustration = async (route: ModelRoute, prompt: string) => {
  const model = route.model;
  const result = await generate(model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });
  const image = result.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!image?.data || !image.mimeType) throw new Error("Gemini image response did not include image bytes");
  return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType, usage: { requestId: result.responseId, model, inputTokens: result.usageMetadata?.promptTokenCount, cachedInputTokens: result.usageMetadata?.cachedContentTokenCount, outputTokens: result.usageMetadata?.candidatesTokenCount, reasoningTokens: result.usageMetadata?.thoughtsTokenCount, inputCharacters: prompt.length } };
};