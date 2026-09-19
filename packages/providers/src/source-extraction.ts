import { createHash } from "node:crypto";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_CHARACTERS = 100_000;
export const SUPPORTED_SOURCE_MIME_TYPES = ["text/plain", "text/markdown", "application/pdf"] as const;
export type SupportedSourceMimeType = (typeof SUPPORTED_SOURCE_MIME_TYPES)[number];

const isPdf = (bytes: Uint8Array) => bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

export const extractUploadedSource = async (params: { bytes: Uint8Array; name: string; mimeType: string }) => {
  if (!SUPPORTED_SOURCE_MIME_TYPES.includes(params.mimeType as SupportedSourceMimeType)) throw new Error("Only TXT, Markdown, and text-based PDF sources are supported.");
  if (params.bytes.byteLength === 0) throw new Error("The uploaded source is empty.");
  if (params.bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("The uploaded source exceeds the 10 MiB limit.");
  if (params.mimeType === "application/pdf" && !isPdf(params.bytes)) throw new Error("The uploaded file is not a valid PDF.");

  let extractedText: string;
  if (params.mimeType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(params.bytes);
    const extracted = await extractText(document, { mergePages: true });
    extractedText = String(extracted.text);
  } else {
    try {
      extractedText = new TextDecoder("utf-8", { fatal: true }).decode(params.bytes);
    } catch {
      throw new Error("The uploaded text source must be valid UTF-8.");
    }
  }

  extractedText = extractedText.replace(/^\uFEFF/, "").trim();
  if (extractedText.length < 3) throw new Error("The uploaded source does not contain extractable text.");
  if (extractedText.length > MAX_SOURCE_CHARACTERS) throw new Error("The extracted source exceeds the 100,000-character limit.");
  return { extractedText, sha256: sha256(params.bytes), byteSize: params.bytes.byteLength };
};
