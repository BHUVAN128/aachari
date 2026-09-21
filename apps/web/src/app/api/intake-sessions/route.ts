import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { IntakeSessionInputSchema } from "@upcraft/contracts";
import { createIntakeSession } from "@upcraft/pipeline/intake";
import { extractUploadedSource } from "@upcraft/providers/source-extraction";

export const runtime = "nodejs";

const urlPattern = /https?:\/\/[^\s]+/i;

const cleanUrl = (value: string) => value.replace(/[),.;]+$/, "");

const parseSource = (message: string) => {
  const delimiter = message.match(/\n\s*source\s*:\s*/i);
  if (!delimiter || delimiter.index === undefined) return { requestText: message.trim(), sourceText: undefined };
  return { requestText: message.slice(0, delimiter.index).trim(), sourceText: message.slice(delimiter.index + delimiter[0].length).trim() };
};

export async function POST(request: Request) {
  let objectKey: string | undefined;
  try {
    const form = await request.formData();
    const message = String(form.get("message") ?? "").trim();
    const language = String(form.get("language") ?? "en").trim();
    const file = form.get("file");
    if (message.length < 3) return NextResponse.json({ error: "Describe the lesson you want to create." }, { status: 400 });

    const parsed = parseSource(message);
    const detected = message.match(urlPattern)?.[0];
    if (file instanceof File && file.size > 0 && (detected || parsed.sourceText)) {
      return NextResponse.json({ error: "Use one source: upload a file, paste a URL, or use a Source: block." }, { status: 400 });
    }

    const sessionId = randomUUID();
    let source;
    if (file instanceof File && file.size > 0) {
      const extensionMime = file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".markdown") ? "text/markdown" : file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain";
      const mimeType = ["text/plain", "text/markdown", "application/pdf"].includes(file.type) ? file.type : extensionMime;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extraction = await extractUploadedSource({ bytes, name: file.name, mimeType });
      objectKey = `intake/${sessionId}/source/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180)}`;
      const { putPrivateObject } = await import("@upcraft/providers/storage");
      await putPrivateObject({ key: objectKey, body: bytes, contentType: mimeType, metadata: { sourceBytesSha256: extraction.sha256 } });
      source = { kind: "file" as const, name: file.name, objectKey, mimeType: mimeType as "text/plain" | "text/markdown" | "application/pdf", byteSize: extraction.byteSize, sha256: extraction.sha256, extractedText: extraction.extractedText };
    } else if (detected) {
      const value = cleanUrl(detected);
      if (!value.toLowerCase().startsWith("https://")) return NextResponse.json({ error: "Source URLs must use HTTPS." }, { status: 400 });
      source = { kind: "url" as const, name: "Primary source", value };
    } else if (parsed.sourceText) {
      source = { kind: "text" as const, name: "Primary source", value: parsed.sourceText };
    }

    const input = IntakeSessionInputSchema.parse({ schemaVersion: "intake-session-input/v1", requestText: parsed.requestText.replace(detected ?? "", "").trim(), language, ...(source ? { source } : {}) });
    const id = await createIntakeSession(input, sessionId);
    return NextResponse.json({ sessionId: id, status: "queued" }, { status: 202 });
  } catch (error) {
    if (objectKey) {
      try { const { deletePrivateObject } = await import("@upcraft/providers/storage"); await deletePrivateObject(objectKey); } catch { /* preserve original error */ }
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start chat intake." }, { status: 400 });
  }
}
