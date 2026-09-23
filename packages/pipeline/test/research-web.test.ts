import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourceEvidenceMap, sourceEvidenceSegments } from "../src/context.ts";
import { assembleBraveDocuments, isAcceptableBraveSource, joinBraveSnippets, normalizeHttpsUrl, parseWebResearchSources, WEB_SOURCE_MAX_BYTES, WEB_SOURCE_MIN_TEXT_LENGTH, isAcceptableWebSource } from "../src/web-research.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("web-research response parsing", () => {
  it("keeps well-formed candidates and drops malformed entries", () => {
    const parsed = parseWebResearchSources({
      schemaVersion: "research-web/v1",
      sources: [
        { url: "https://www.example.edu/a", title: "A", reason: "authoritative" },
        { url: "https://www.example.edu/b", title: "B", reason: "current" },
        { url: "https://www.example.edu/c" },
        "not-an-object",
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ url: "https://www.example.edu/a", title: "A", reason: "authoritative" });
  });

  it("returns an empty list for a missing or malformed payload", () => {
    expect(parseWebResearchSources(undefined)).toEqual([]);
    expect(parseWebResearchSources({ sources: "nope" })).toEqual([]);
  });
});

describe("web source quality gate", () => {
  it("accepts only HTTPS URLs and uses a stable dedupe key", () => {
    expect(normalizeHttpsUrl("http://example.com/x")).toBeUndefined();
    expect(normalizeHttpsUrl("not a url")).toBeUndefined();
    const a = normalizeHttpsUrl("https://www.example.edu/lesson/");
    const b = normalizeHttpsUrl("https://www.example.edu/lesson");
    expect(a?.key).toBe("www.example.edu/lesson");
    expect(a?.key).toBe(b?.key);
  });

  it("rejects insecure, non-text, too-short, or oversized pages", () => {
    expect(isAcceptableWebSource({ contentType: "text/html", textLength: WEB_SOURCE_MIN_TEXT_LENGTH, byteSize: 1_000 })).toBe(true);
    expect(isAcceptableWebSource({ contentType: "application/octet-stream", textLength: 5_000, byteSize: 1_000 })).toBe(false);
    expect(isAcceptableWebSource({ contentType: "text/html", textLength: WEB_SOURCE_MIN_TEXT_LENGTH - 1, byteSize: 1_000 })).toBe(false);
    expect(isAcceptableWebSource({ contentType: "text/html", textLength: 5_000, byteSize: WEB_SOURCE_MAX_BYTES + 1 })).toBe(false);
  });
});

describe("Brave LLM Context source policy", () => {
  const longSnippets = ["Photosynthesis converts light energy into chemical energy. ".repeat(4).trim(), "Chlorophyll absorbs light and releases oxygen. ".repeat(4).trim()];

  it("joins snippets losslessly and only accepts HTTPS sources above the minimum length", () => {
    const source = { url: "https://www.example.edu/photosynthesis", snippets: longSnippets };
    expect(joinBraveSnippets(source.snippets)).toBe(longSnippets.join(" "));
    expect(isAcceptableBraveSource(source)).toBe(true);
    expect(isAcceptableBraveSource({ url: "http://insecure.example.edu/x", snippets: longSnippets })).toBe(false);
    expect(isAcceptableBraveSource({ url: "https://short.example.edu/x", snippets: ["too short"] })).toBe(false);
  });

  it("assembles deduped documents with per-URL provenance", () => {
    const first = { url: "https://www.example.edu/photosynthesis", snippets: longSnippets };
    const documents = assembleBraveDocuments([first, { ...first }, { url: "http://insecure.example.edu/x", snippets: longSnippets }]);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.extractedText.startsWith("Photosynthesis")).toBe(true);
    expect(documents[0]!.sha256).toHaveLength(64);
    expect(documents[0]!.sourceBytesSha256).toHaveLength(64);
    expect(documents[0]!.mimeType).toBe("text/plain");
    expect(documents[0]!.byteSize).toBeGreaterThanOrEqual(WEB_SOURCE_MIN_TEXT_LENGTH);
  });
});

describe("source-less run evidence mapping", () => {
  it("builds a valid locked evidence map from web-retrieved source rows", () => {
    const text = "Photosynthesis converts light energy into chemical energy. " + "Chlorophyll absorbs light. ".repeat(40);
    const rows = [
      { id: "11111111-1111-4111-8111-111111111111", sha256: sha(text), extractedText: text },
      { id: "22222222-2222-4222-8222-222222222222", sha256: sha(text + " extra"), extractedText: text + " extra" },
    ];
    const map = buildSourceEvidenceMap(rows);
    expect(map.schemaVersion).toBe("source-evidence-map/v1");
    expect(map.sources).toHaveLength(2);
    const allSegments = map.sources.flatMap((source) => source.segments);
    expect(allSegments.length).toBeGreaterThan(0);
    for (const source of map.sources) {
      expect(source.segments.map((segment) => segment.text).join("")).toBe(rows.find((row) => row.id === source.sourceId)?.extractedText);
    }
    const first = map.sources[0]!;
    const [segment] = sourceEvidenceSegments(map, [{ sourceId: first.sourceId, sourceHash: first.sourceHash, segmentIds: [first.segments[0]!.id] }]);
    expect(segment?.id).toBe(first.segments[0]!.id);
  });
});
