import { ApprovedScriptSchema, FactPackSchema, ScriptVerificationSchema } from "@upcraft/contracts";
import { generateStructuredText, resolveModelRoute, reviewWithRoute } from "@upcraft/providers";
import { saveArtifact, requireContent, validationFeedback } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage } from "../../usage.ts";
import { getRun } from "../../runs.ts";
import { assertScriptVerificationComplete } from "../../verification.ts";
import { contextManifest, projectScriptContext } from "../../context.ts";
import { scriptJsonSchema } from "../../prompts/script.ts";
import type { StageContext } from "../context.ts";

type Json = Record<string, unknown>;

/** §5 M4 Script approval — write narration, then independently verify it. */
export const runScript = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const [blueprint, factPack] = await Promise.all([ctx.getArtifact(runId, "lesson-blueprint"), ctx.getArtifact(runId, "fact-pack")]);
  const startedAt = Date.now();
  const blueprintContent = requireContent<{ scenes: Array<{ id: string; claimIds: string[]; purpose: string; visualBeat: string }> }>(blueprint, "lesson-blueprint");
  const factPackContent = FactPackSchema.parse(requireContent(factPack, "fact-pack"));
  const scriptContext = projectScriptContext(factPackContent, blueprintContent);
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  const snapshotProjection = `Learner level: ${run.snapshot.learningLevel}\nAudience: ${run.snapshot.audienceCategory}\nLanguage: ${run.snapshot.language}\nDuration budget: ${run.snapshot.durationSeconds}s\n`;
  const route = ctx.route("script")!;
  const generated = await withFallback(route, async (attemptRoute) => generateStructuredText<Json>(attemptRoute, { schemaName: "approved_script", jsonSchema: scriptJsonSchema, prompt: `${await validationFeedback(runId, "script")}Write narration strictly from this scene plan and its verified claims. ${snapshotProjection}Return schemaVersion "approved-script/v2" and narration [{id,sceneId,text,claimIds,visualAction}]. Do not introduce uncited claims and do not return a separate fullText field.\n${JSON.stringify(scriptContext)}` }), async (failedRoute, error) => {
    await recordUsage(runId, "script", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "script/v2", { projection: "scene-claim-projection/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "script", generated.route.provider, generated.route.model, startedAt, generated.value.usage, "script/v2", contextManifest("scene-claim-projection/v1", [{ role: "script-context", hash: sha(scriptContext), chars: JSON.stringify(scriptContext).length, itemCount: scriptContext.claims.length + scriptContext.scenes.length }]));
  const script = ApprovedScriptSchema.parse(generated.value.value); const claimIds = new Set(factPackContent.claims.map((claim) => claim.id)); const sceneIds = new Set(blueprintContent.scenes.map((scene) => scene.id)); if (script.narration.some((line) => !sceneIds.has(line.sceneId) || line.claimIds.some((claimId) => !claimIds.has(claimId)))) throw new Error("Script contains an invalid scene or claim reference");
  const verifierStartedAt = Date.now();
  const verificationContext = { schemaVersion: "script-verification-context/v1", narration: script.narration, claims: factPackContent.claims.filter((claim) => new Set(script.narration.flatMap((line) => line.claimIds)).has(claim.id)) };
  const verificationRun = await withFallback(resolveModelRoute("script-verification"), (attemptRoute) => reviewWithRoute(attemptRoute, `Independently verify every narration line against only its supplied verified claims. Return schemaVersion "script-verification/v2", one evidence item per line with lineId, supported, unsupportedClaimIds, rationale, and notes. Do not rewrite the script.\n${JSON.stringify(verificationContext)}`), async (failedRoute, error) => {
    await recordUsage(runId, "script", failedRoute.provider, failedRoute.model, verifierStartedAt, { model: failedRoute.model }, "script-verification/v2", { projection: "line-claim-projection/v1" }, "failed", error.code);
  });
  await recordUsage(runId, "script", verificationRun.route.provider, verificationRun.route.model, verifierStartedAt, verificationRun.value.usage, "script-verification/v2", contextManifest("line-claim-projection/v1", [{ role: "script-verification-context", hash: sha(verificationContext), chars: JSON.stringify(verificationContext).length, itemCount: script.narration.length }]));
  const verification = ScriptVerificationSchema.parse(verificationRun.value.value);
  assertScriptVerificationComplete(verification, script);
  return saveArtifact({ runId, stage: "script", role: "approved-script", schemaVersion: script.schemaVersion, inputHash: sha([blueprint?.sha256, factPack?.sha256]), content: script });
};