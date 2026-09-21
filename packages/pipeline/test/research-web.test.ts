import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourceEvidenceMap, sourceEvidenceSegments } from "../src/context.ts";
import { WEB_SOURCE_MAX_BYTES, WEB_SOURCE_MIN_TEXT_LENGTH, isAcceptableWebSource, normalizeHttpsUrl, parseWebResearchSources } from "../src/web-research.ts";

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
