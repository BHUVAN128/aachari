import { describe, expect, it } from "vitest";
import { extractUploadedSource } from "../src/source-extraction.ts";

describe("uploaded source extraction", () => {
  it("extracts UTF-8 text and hashes raw bytes", async () => {
    const bytes = new TextEncoder().encode("Photosynthesis working: light energy becomes chemical energy.");
    const result = await extractUploadedSource({ bytes, name: "source.txt", mimeType: "text/plain" });
    expect(result.extractedText).toContain("Photosynthesis working");
    expect(result.sha256).toHaveLength(64);
    expect(result.byteSize).toBe(bytes.byteLength);
  });

  it("rejects unsupported uploads", async () => {
    await expect(extractUploadedSource({ bytes: new TextEncoder().encode("hello"), name: "source.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).rejects.toThrow("Only TXT");
  });
});
