import { and, asc, eq, inArray } from "drizzle-orm";
import { ApprovedScriptSchema } from "@upcraft/contracts";
import { assetAnchors, getDb, mediaAssets } from "@upcraft/db";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { getRun } from "../../runs.ts";
import { solveSceneLayout } from "../../spatial.ts";
import type { StageContext } from "../context.ts";
import { sceneDiagramArea } from "../scene-area.ts";

const ANCHOR_PROVIDERS = new Set(["svg", "mask", "landmark", "detection", "review"]);

/**
 * §8 M7 Spatial layout — solve each scene's `resolved-layout/v1` from measured
 * anchors. The base diagram is placed at its computed area and any selected
 * illustration is attached to a measured diagram anchor with the deterministic
 * solver, which then asserts anchor drift; no model supplies pixels.
 */
export const runSpatialLayout = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [run, scriptArtifact, selectedArtifact, assets] = await Promise.all([
    getRun(runId),
    ctx.getArtifact(runId, "approved-script"),
    ctx.getArtifact(runId, "selected-assets"),
    getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.selected, true))),
  ]);
  if (!run) throw new Error("Run not found");
  const script = ApprovedScriptSchema.parse(requireContent(scriptArtifact, "approved-script"));
  const selected = selectedArtifact?.content as { illustrationDecisions?: Array<{ sceneId: string; choice: string; assetId?: string }> } | undefined;
  const canvas = run.snapshot.aspectRatio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const area = sceneDiagramArea(canvas);
  const sceneIds = [...new Set(script.narration.map((line) => line.sceneId))];
  const anchorRows = assets.length
    ? await getDb().select().from(assetAnchors).where(inArray(assetAnchors.assetId, assets.map((asset) => asset.id))).orderBy(asc(assetAnchors.name))
    : [];

  const layouts = sceneIds.map((sceneId) => {
    const diagramAsset = assets.find((asset) => asset.sceneId === sceneId && asset.role === "diagram-" + sceneId);
    if (!diagramAsset) throw new Error("Spatial layout requires a selected diagram asset for scene " + sceneId);
    const anchors = anchorRows.filter((row) => row.assetId === diagramAsset.id && ANCHOR_PROVIDERS.has(row.provider)).map((row) => ({
      name: row.name,
      point: { x: row.x / 1_000_000, y: row.y / 1_000_000 },
      provider: row.provider as "svg" | "mask" | "landmark" | "detection" | "review",
    }));
    const decision = selected?.illustrationDecisions?.find((entry) => entry.sceneId === sceneId && entry.choice === "selected" && entry.assetId);
    const illustrationAsset = decision?.assetId ? assets.find((asset) => asset.id === decision.assetId) : undefined;
    const targetAnchor = anchors.find((anchor) => anchor.name.endsWith(":center"))?.name;
    const illustration = illustrationAsset?.width && illustrationAsset.height && targetAnchor
      ? { assetId: illustrationAsset.id, width: illustrationAsset.width, height: illustrationAsset.height, targetAnchor, zIndex: 0 }
      : undefined;
    return solveSceneLayout({
      sceneId,
      canvas,
      diagram: { assetId: diagramAsset.id, width: canvas.width, height: canvas.height, bounds: area, anchors, zIndex: 1 },
      ...(illustration ? { illustration } : {}),
    });
  });
  return saveArtifact({ runId, stage: "spatial-layout", role: "resolved-layout", schemaVersion: "resolved-layout/v1", inputHash: sha([script, selectedArtifact?.sha256 ?? null]), content: { schemaVersion: "resolved-layout/v1", canvas, layouts } });
};