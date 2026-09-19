import { createHash } from "node:crypto";
import {
  SourceEvidenceMapSchema,
  type ApprovedScript,
  type FactPack,
  type SourceEvidenceMap,
  type SourceSegment,
} from "@upcraft/contracts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Split without dropping or normalizing source bytes. Offsets are UTF-16 offsets, matching JS strings. */
export const buildSourceEvidenceMap = (sources: Array<{ id: string; sha256: string; extractedText: string | null }>) => SourceEvidenceMapSchema.parse({
  schemaVersion: "source-evidence-map/v1",
  sources: sources.map((source) => {
    if (!source.extractedText) throw new Error(`Source ${source.id} has no locked extracted text`);
    const text = source.extractedText;
    const segments: SourceSegment[] = [];
    const targetSize = 6_000;
    let start = 0;
    let ordinal = 0;
    while (start < text.length || (text.length === 0 && ordinal === 0)) {
      if (text.length === 0) {
        segments.push({ id: sha(`${source.id}:${source.sha256}:0:0`), sourceId: source.id, sourceHash: source.sha256, ordinal: 0, startOffset: 0, endOffset: 0, text: "" });
        break;
      }
      let end = Math.min(start + targetSize, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(" ", end);
        if (boundary > start + 1_000) end = boundary + 1;
      }
      const segmentText = text.slice(start, end);
      segments.push({ id: sha(`${source.id}:${source.sha256}:${start}:${end}`), sourceId: source.id, sourceHash: source.sha256, ordinal, startOffset: start, endOffset: end, text: segmentText });
      start = end;
      ordinal += 1;
    }
    if (segments.map((segment) => segment.text).join("") !== text) throw new Error(`Source segmentation lost bytes for ${source.id}`);
    return { sourceId: source.id, sourceHash: source.sha256, segments };
  }),
});

export const sourceEvidenceSegments = (map: SourceEvidenceMap, refs: Array<{ sourceId: string; sourceHash: string; segmentIds: string[] }>) => {
  const segments: SourceSegment[] = [];
  for (const ref of refs) {
    const source = map.sources.find((candidate) => candidate.sourceId === ref.sourceId && candidate.sourceHash === ref.sourceHash);
    if (!source) throw new Error(`Evidence source ${ref.sourceId} is not in the locked source map`);
    for (const segmentId of ref.segmentIds) {
      const segment = source.segments.find((candidate) => candidate.id === segmentId);
      if (!segment) throw new Error(`Evidence segment ${segmentId} is not in the locked source map`);
      segments.push(segment);
    }
  }
  return [...new Map(segments.map((segment) => [segment.id, segment])).values()];
};

export const canonicalNarrationText = (script: Pick<ApprovedScript, "narration">) => script.narration.map((line) => line.text.trim()).join("\n\n");

export const projectFactVerificationContext = (factPack: FactPack, map: SourceEvidenceMap) => ({
  schemaVersion: "fact-verification-context/v1",
  claims: factPack.claims,
  evidenceSegments: sourceEvidenceSegments(map, factPack.claims.map((claim) => claim.evidence)),
});

export const projectScriptContext = (factPack: FactPack, blueprint: { scenes: Array<{ id: string; claimIds: string[] }> }) => {
  const claimIds = new Set(blueprint.scenes.flatMap((scene) => scene.claimIds));
  return {
    schemaVersion: "script-context/v1",
    scenes: blueprint.scenes,
    claims: factPack.claims.filter((claim) => claimIds.has(claim.id)),
    caveats: factPack.caveats,
  };
};

export const projectVisualContext = (script: Pick<ApprovedScript, "narration">) => ({
  schemaVersion: "visual-context/v1",
  narration: script.narration.map(({ sceneId, text, visualAction }) => ({ sceneId, text, visualAction })),
});

export const contextManifest = (projection: string, inputs: Array<{ role: string; hash: string; chars: number; itemCount?: number }>) => ({
  projection,
  inputs: inputs.map((input) => ({ ...input })),
  totalChars: inputs.reduce((sum, input) => sum + input.chars, 0),
});
