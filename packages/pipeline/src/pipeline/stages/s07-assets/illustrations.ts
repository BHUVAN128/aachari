import { and, eq } from "drizzle-orm";
import { getDb, mediaAssets, qaFindings } from "@upcraft/db";
import { generateIllustration, ProviderError, putPrivateObject, resolveCapabilities, resolveModelRoute } from "@upcraft/providers";
import { imageDimensions, validateIllustrationCandidate } from "../../../media-qa.ts";
import { recordUsage } from "../../../usage.ts";
import { contextManifest } from "../../../context.ts";
import { sha } from "../../../artifacts/hashing.ts";
import type { Domain, ModelRoute, SceneAssetBrief, StageName, VisualBible } from "@upcraft/contracts";

type IllustrationDecision = { sceneId: string; choice: "selected" | "omitted"; role?: string; assetId?: string; reason: string };
type PlannedIllustration = { direction: { sceneId: string }; brief: SceneAssetBrief };

/**
 * §7 M6 optional illustrations. Illustration is never required: capability
 * absence, verification failure, or generation failure becomes an explicit
 * omission record, and a selected AI illustration always forces human review
 * before publication. Multi-candidate evaluation remains deferred; one candidate
 * or a recorded omission is sufficient.
 *
 * Pure extraction from `runAssets`, preserving selection and omission semantics.
 */
export const renderIllustrations = async (params: {
  runId: string;
  stage: StageName;
  domain: Domain;
  planned: PlannedIllustration[];
  bible: VisualBible;
  briefArtifactId: string;
  briefs: unknown;
  briefArtifactSha256: string | null;
  illustrationRoute: ModelRoute | undefined;
}): Promise<IllustrationDecision[]> => {
  const { runId, stage, domain, planned, bible, briefArtifactId, briefs, briefArtifactSha256, illustrationRoute } = params;
  const illustrationAvailable = resolveCapabilities(domain).some((capability) => capability.capability === "illustration" && capability.available);
  const illustrationModel = illustrationRoute?.model ?? "gemini-3.1-flash-image";
  return Promise.all(planned.map(async ({ direction, brief }): Promise<IllustrationDecision> => {
    if (!brief.illustration.required) return { sceneId: direction.sceneId, choice: "omitted", reason: brief.illustration.reason ?? "No illustration planned for this scene." };
    const role = "illustration-" + direction.sceneId;
    const existingIllustration = (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.selected, true))))[0];
    if (existingIllustration) return { sceneId: direction.sceneId, choice: "selected", role, assetId: existingIllustration.id, reason: brief.illustration.reason ?? "Existing selected illustration reused." };
    if (!illustrationAvailable) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration capability is unavailable; the deterministic vector treatment is used instead." };
    const startedAt = Date.now();
    try {
      const stylePrompt = `${brief.illustration.prompt}\nVisual bible: canvas texture ${bible.canvasTexture}; line style ${bible.lineStyle}; palette ${bible.palette.join(", ")}; body font ${bible.typography.body}.`;
      const generated = await generateIllustration(illustrationRoute ?? resolveModelRoute("illustration"), stylePrompt);
      const issues = validateIllustrationCandidate({ bytes: generated.bytes, mimeType: generated.mimeType });
      await recordUsage(runId, stage, "gemini", illustrationModel, startedAt, generated.usage, "illustration/v1", contextManifest("scene-asset-brief/v1", [{ role: "scene-asset-briefs", hash: briefArtifactSha256 ?? sha(briefs), chars: JSON.stringify(brief).length, itemCount: 1 }]), issues.length ? "failed" : "completed", issues.length ? "ILLUSTRATION_VERIFICATION" : undefined);
      if (issues.length) {
        await getDb().insert(qaFindings).values(issues.map((issue) => ({ runId, rule: issue.rule, severity: "warning" as const, evidence: { sceneId: direction.sceneId, ...issue.evidence }, remediation: issue.remediation })));
        return { sceneId: direction.sceneId, choice: "omitted", reason: "Generated illustration failed deterministic verification; deterministic vector treatment retained." };
      }
      const dimensions = imageDimensions(generated.bytes, generated.mimeType);
      if (!dimensions) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration dimensions were unreadable; deterministic vector treatment retained." };
      const object = await putPrivateObject({ key: `runs/${runId}/assets/illustration-${direction.sceneId}`, body: generated.bytes, contentType: generated.mimeType });
      const [asset] = await getDb().insert(mediaAssets).values({ runId, sceneId: direction.sceneId, role, objectKey: object.key, sha256: object.sha256, mimeType: generated.mimeType, byteSize: object.byteSize, width: dimensions.width, height: dimensions.height, selected: true, provenance: { kind: "illustration", provider: "gemini", model: illustrationModel, prompt: brief.illustration.prompt, prohibitedText: true, briefReason: brief.illustration.reason, sceneAssetBriefArtifactId: briefArtifactId, visualBibleHash: sha(bible) } }).onConflictDoNothing().returning();
      const stable = asset ?? (await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.runId, runId), eq(mediaAssets.role, role), eq(mediaAssets.sha256, object.sha256))))[0];
      if (!stable) return { sceneId: direction.sceneId, choice: "omitted", reason: "Illustration persistence failed; deterministic vector treatment retained." };
      return { sceneId: direction.sceneId, choice: "selected", role, assetId: stable.id, reason: brief.illustration.reason ?? "Selected illustration." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "illustration generation failed";
      await recordUsage(runId, stage, "gemini", illustrationModel, startedAt, { model: illustrationModel }, "illustration/v1", { projection: "scene-asset-brief/v1" }, "failed", error instanceof ProviderError ? error.code : "ILLUSTRATION_GENERATION");
      return { sceneId: direction.sceneId, choice: "omitted", reason: `Illustration generation failed and was recorded as an omission: ${message}` };
    }
  }));
};