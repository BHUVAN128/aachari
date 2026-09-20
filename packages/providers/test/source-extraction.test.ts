import { describe, expect, it } from "vitest";
import { MAX_SOURCE_BYTES, MAX_SOURCE_CHARACTERS, extractUploadedSource } from "../src/source-extraction.ts";

/** Builds a minimal, valid single-page PDF with a real text layer. */
const buildTextPdf = (text: string): Uint8Array => {
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

describe("uploaded source extraction", () => {
  it("extracts UTF-8 text and hashes raw bytes", async () => {
    const bytes = new TextEncoder().encode("Photosynthesis working: light energy becomes chemical energy.");
    const result = await extractUploadedSource({ bytes, name: "source.txt", mimeType: "text/plain" });
    expect(result.extractedText).toContain("Photosynthesis working");
    expect(result.sha256).toHaveLength(64);
    expect(result.byteSize).toBe(bytes.byteLength);
  });

  it("extracts the text layer of a PDF and hashes the original bytes", async () => {
    const bytes = buildTextPdf("Photosynthesis working");
    const result = await extractUploadedSource({ bytes, name: "source.pdf", mimeType: "application/pdf" });
    expect(result.extractedText).toBe("Photosynthesis working");
    expect(result.sha256).toHaveLength(64);
    expect(result.byteSize).toBe(bytes.byteLength);
  });

  it("rejects a file labeled PDF that is not a real PDF", async () => {
    await expect(extractUploadedSource({ bytes: new TextEncoder().encode("not a pdf at all"), name: "fake.pdf", mimeType: "application/pdf" })).rejects.toThrow("not a valid PDF");
  });

  it("rejects unsupported uploads and empty sources", async () => {
    await expect(extractUploadedSource({ bytes: new TextEncoder().encode("hello"), name: "source.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).rejects.toThrow("Only TXT");
    await expect(extractUploadedSource({ bytes: new Uint8Array(), name: "empty.txt", mimeType: "text/plain" })).rejects.toThrow("empty");
  });

  it("enforces the byte and character extraction limits", () => {
    expect(MAX_SOURCE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_SOURCE_CHARACTERS).toBe(100_000);
  });

  it("rejects a source larger than the byte budget before parsing", async () => {
    const bytes = new Uint8Array(MAX_SOURCE_BYTES + 1);
    await expect(extractUploadedSource({ bytes, name: "huge.txt", mimeType: "text/plain" })).rejects.toThrow("10 MiB");
  });
});
