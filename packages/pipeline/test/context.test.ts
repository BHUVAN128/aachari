import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, FactPackSchema } from "@upcraft/contracts";
import { buildSourceEvidenceMap, buildSourceEvidenceMapWithOverlap, canonicalNarrationText, projectScriptContext, sourceEvidenceSegments } from "../src/context.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("token-safe context projections", () => {
  it("segments sources losslessly and resolves only cited evidence", () => {
    const text = "A source paragraph with a claim.\n\nA second paragraph with another claim.";
    const map = buildSourceEvidenceMap([{ id: sourceId, sha256: sha(text), extractedText: text }]);
    const source = map.sources[0]!;
    expect(source.segments.map((segment) => segment.text).join("")).toBe(text);
    expect(sourceEvidenceSegments(map, [{ sourceId, sourceHash: source.sourceHash, segmentIds: [source.segments[0]!.id] }])).toHaveLength(1);
    expect(() => sourceEvidenceSegments(map, [{ sourceId, sourceHash: source.sourceHash, segmentIds: ["missing-segment"] }])).toThrow(/not in the locked source map/);
  });

  it("rejects stale evidence when the locked source hash changed", () => {
    const text = "Locked source text for the evidence map.";
    const map = buildSourceEvidenceMap([{ id: sourceId, sha256: sha(text), extractedText: text }]);
    const staleHash = sha("different content");
    expect(() => sourceEvidenceSegments(map, [{ sourceId, sourceHash: staleHash, segmentIds: [map.sources[0]!.segments[0]!.id] }])).toThrow(/not in the locked source map/);
    expect(() => sourceEvidenceSegments(map, [{ sourceId: "99999999-9999-4999-8999-999999999999", sourceHash: map.sources[0]!.sourceHash, segmentIds: [] }])).toThrow(/not in the locked source map/);
  });

  it("derives one canonical narration string without duplicated fullText", () => {
    const script = ApprovedScriptSchema.parse({
      schemaVersion: "approved-script/v2",
      narration: [
        { id: "22222222-2222-4222-8222-222222222222", sceneId: "33333333-3333-4333-8333-333333333333", text: "First line", claimIds: [], visualAction: "Reveal" },
        { id: "44444444-4444-4444-8444-444444444444", sceneId: "55555555-5555-4555-8555-555555555555", text: "Second line", claimIds: [], visualAction: "Connect" },
      ],
    });
    expect(canonicalNarrationText(script)).toBe("First line\n\nSecond line");
    expect(Object.hasOwn(script, "fullText")).toBe(false);
  });

  it("keeps a definition straddling the segment target inside one primary segment and emits overlap evidence", () => {
    const prefix = "Filler background sentence about light and water. ".repeat(150).trim();
    const definition = "Photosynthesis is the light-driven splitting of water molecules into oxygen and hydrogen ions.";
    const text = `${prefix} ${definition} ${"More detail follows. ".repeat(60).trim()}`;
    const { map, overlaps, primaryJoin } = buildSourceEvidenceMapWithOverlap([{ id: sourceId, sha256: sha(text), extractedText: text }]);
    expect(primaryJoin).toBe(text);
    const segments = map.sources[0]!.segments;
    expect(segments.length).toBeGreaterThan(1);
    for (let index = 1; index < segments.length; index += 1) expect(segments[index]!.startOffset).toBe(segments[index - 1]!.endOffset);
    expect(segments.some((segment) => segment.text.includes(definition))).toBe(true);
    expect(overlaps.length).toBeGreaterThanOrEqual(segments.length - 1);
    expect(overlaps.every((segment) => segment.overlap && segment.text.length <= 300)).toBe(true);
  });

  it("passes only blueprint-referenced claims to script generation", () => {
    const sourceHash = sha("source");
    const factPack = FactPackSchema.parse({
      schemaVersion: "fact-pack/v2",
      claims: [
        { id: "66666666-6666-4666-8666-666666666666", text: "Used", evidence: { sourceId, sourceHash, segmentIds: ["segment-used"], locator: "p1" }, critical: true },
        { id: "77777777-7777-4777-8777-777777777777", text: "Not used", evidence: { sourceId, sourceHash, segmentIds: ["segment-unused"], locator: "p2" }, critical: false },
      ],
      caveats: [{ text: "Use context." }],
    });
    const projected = projectScriptContext(factPack, { scenes: [{ id: "88888888-8888-4888-8888-888888888888", claimIds: [factPack.claims[0]!.id] }] });
    expect(projected.claims.map((claim) => claim.id)).toEqual([factPack.claims[0]!.id]);
    expect(projected.caveats).toHaveLength(1);
  });
});
