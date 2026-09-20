import { and, eq } from "drizzle-orm";
import { assetAnchors, getDb, mediaAssets, qaFindings } from "@upcraft/db";
import { putPrivateObject } from "@upcraft/providers";
import { renderAndValidateDiagram, type DiagramPalette } from "../../../diagram-qa.ts";
import { sha } from "../../../artifacts/hashing.ts";
import type { DiagramModel } from "@upcraft/contracts";

type PlannedDiagram = { direction: { sceneId: string }; model: DiagramModel };

/**
 * §7 M6 deterministic diagrams. Typed `diagram-model/v1` models are rendered to
 * SVG by code, persisted, and their measured anchors recorded. Image models are
 * never used for factual diagrams, labels, equations, charts, or arrows.
 *
 * Pure extraction from `runAssets`, preserving the exact call order (render,
 * verify, persist, then anchor) so behavior and provenance are unchanged.
 */
export const renderDiagrams = async (params: {
  runId: string;
  planned: PlannedDiagram[];
  canvas: { width: number; height: number };
  area: { x: number; y: number; width: number; height: number };
  lockedTexts: string[];
  allowedClaimIds: Set<string>;
  palette: DiagramPalette;
  scenePlanArtifactId: string;
  briefArtifactId: string;
  script: unknown;
  bible: unknown;
}) => {
  const { runId, planned, canvas, area, lockedTexts, allowedClaimIds, palette, scenePlanArtifactId, briefArtifactId, script, bible } = params;
  return Promise.all(planned.map(async ({ direction, model }) => {
    const role = "diagram-" + direction.sceneId;
    const existingAsset = (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.selected, true))))[0];
    if (existingAsset) return existingAsset;
    const rendered = renderAndValidateDiagram({ model, palette, canvas, area, lockedTexts, allowedClaimIds });
    if (!rendered.passed) {
      await getDb().insert(qaFindings).values(rendered.issues.map((issue) => ({ runId, rule: issue.rule, severity: "critical" as const, evidence: { sceneId: direction.sceneId, ...issue.evidence }, remediation: issue.remediation })));
      throw new Error(`Diagram QA failed for scene ${direction.sceneId}: ${rendered.issues.map((issue) => issue.rule).join(", ")}`);
    }
    const object = await putPrivateObject({ key: `runs/${runId}/assets/scene-${direction.sceneId}.svg`, body: rendered.svg, contentType: "image/svg+xml" });
    const [asset] = await getDb().insert(mediaAssets).values({
      runId, sceneId: direction.sceneId, role, objectKey: object.key, sha256: object.sha256, mimeType: "image/svg+xml",
      byteSize: object.byteSize, width: canvas.width, height: canvas.height, selected: true,
      provenance: {
        kind: "typed-svg", diagramKind: model.kind, labels: model.labels, diagramModelHash: sha(model),
        scenePlanArtifactId, sceneAssetBriefArtifactId: briefArtifactId,
        scriptHash: sha(script), visualBibleHash: sha(bible),
      },
    }).onConflictDoNothing().returning();
    const stableAsset = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.sha256, object.sha256))))[0];
    if (!stableAsset) throw new Error("Selected asset persistence failed");
    if (rendered.layout.anchors.length) {
      await getDb().insert(assetAnchors).values(rendered.layout.anchors.map((anchor) => ({
        assetId: stableAsset.id, name: anchor.name, x: Math.round(anchor.x * 1_000_000), y: Math.round(anchor.y * 1_000_000),
        provider: "svg", confidenceMillionths: 1_000_000,
      }))).onConflictDoNothing();
    }
    return stableAsset;
  }));
};