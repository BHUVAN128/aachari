import { describe, expect, it } from "vitest";
import { FactPackSchema, SourceEvidenceMapSchema, type FactPack } from "@upcraft/contracts";
import { withEvidenceWindow } from "../src/context.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const sourceIdB = "22222222-2222-4222-8222-222222222222";
const sourceHash = "a".repeat(64);
const sourceHashB = "b".repeat(64);
const claimId = "33333333-3333-4333-8333-333333333333";

const mapFor = (sources: Array<{ sourceId: string; hash: string; texts: string[] }>) => SourceEvidenceMapSchema.parse({
  schemaVersion: "source-evidence-map/v1",
  sources: sources.map((source) => {
    let offset = 0;
    const segments = source.texts.map((text, ordinal) => {
      const segment = { id: `seg-${source.sourceId.slice(0, 4)}-${String(ordinal).padStart(4, "0")}`, sourceId: source.sourceId, sourceHash: source.hash, ordinal, startOffset: offset, endOffset: offset + text.length, text };
      offset += text.length;
      return segment;
    });
    return { sourceId: source.sourceId, sourceHash: source.hash, segments };
  }),
});

const packCiting = (segmentId: string, id = claimId): FactPack => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [{ id, text: "Claim.", evidence: { sourceId, sourceHash, segmentIds: [segmentId], locator: "p" }, critical: true }],
  caveats: [],
});

describe("claim-local evidence window", () => {
  it("pulls ±1 same-source neighbours and tags the cited segment", () => {
    const map = mapFor([{ sourceId, hash: sourceHash, texts: ["alpha ".repeat(5), "the cited sentence.", "omega ".repeat(5)] }]);
    const window = withEvidenceWindow(packCiting(map.sources[0]!.segments[1]!.id), map);
    expect(window.evidenceSegments.map((segment) => segment.ordinal)).toEqual([0, 1, 2]);
    expect(window.evidenceSegments.filter((segment) => segment.cited).map((segment) => segment.ordinal)).toEqual([1]);
    expect(window.manifest).toMatchObject({ citedSegments: 1, neighborSegments: 2 });
  });

  it("never pulls a neighbour from another source", () => {
    const map = mapFor([
      { sourceId, hash: sourceHash, texts: ["a1", "a2", "a3"] },
      { sourceId: sourceIdB, hash: sourceHashB, texts: ["b1", "b2", "b3"] },
    ]);
    const window = withEvidenceWindow(packCiting(map.sources[0]!.segments[1]!.id), map);
    expect(window.evidenceSegments.every((segment) => segment.sourceId === sourceId)).toBe(true);
  });

  it("respects the hard character budget by omitting, not truncating, a neighbour", () => {
    const map = mapFor([{ sourceId, hash: sourceHash, texts: ["n".repeat(200), "small cite", "x".repeat(1_000)] }]);
    const window = withEvidenceWindow(packCiting(map.sources[0]!.segments[1]!.id), map, { maxWindowChars: 250 });
    expect(window.manifest.totalChars).toBeLessThanOrEqual(250);
    expect(window.manifest.omittedNeighborSegments).toBe(1);
    expect(window.evidenceSegments.some((segment) => segment.cited)).toBe(true);
  });
});
