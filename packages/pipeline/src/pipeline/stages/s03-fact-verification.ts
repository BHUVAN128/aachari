import { ClaimVerificationSchema, FactPackSchema, SourceEvidenceMapSchema } from "@upcraft/contracts";
import { eq } from "drizzle-orm";
import { getDb, sourceClaims } from "@upcraft/db";
import { reviewWithRoute } from "@upcraft/providers";
import { saveArtifact, requireContent } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import { withFallback } from "../../fallback.ts";
import { recordUsage } from "../../usage.ts";
import { assertClaimVerificationComplete } from "../../verification.ts";
import { contextManifest, projectFactVerificationContext, sourceEvidenceSegments } from "../../context.ts";
import type { StageContext } from "../context.ts";

/** §3 M2 independent claim verification — a second provider checks the fact pack. */
export const runFactVerification = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const factPack = requireContent(await ctx.getArtifact(runId, "fact-pack"), "fact-pack");
  const evidenceMap = SourceEvidenceMapSchema.parse(requireContent(await ctx.getArtifact(runId, "source-evidence-map"), "source-evidence-map"));
  const startedAt = Date.now();
  const route = ctx.route("fact-verification")!;
  const verificationContext = projectFactVerificationContext(FactPackSchema.parse(factPack), evidenceMap);
  const verificationRun = await withFallback(route, (attemptRoute) => reviewWithRoute(attemptRoute, `Independently verify every claim against only its supplied source segments. Return schemaVersion "claim-verification/v2", one evidence item per claim with claimId, sourceId, segmentIds, supported, rationale, and notes. Do not add facts, use uncited sources, or reproduce source text.\n${JSON.stringify(verificationContext)}`), async (failedRoute, error) => {
    await recordUsage(runId, "fact-verification", failedRoute.provider, failedRoute.model, startedAt, { model: failedRoute.model }, "fact-verification/v2", { projection: "claim-local-evidence/v1" }, "failed", error.code);
  });
  const verificationResult = verificationRun.value;
  await recordUsage(runId, "fact-verification", verificationRun.route.provider, verificationRun.route.model, startedAt, verificationResult.usage, "fact-verification/v2", contextManifest("claim-local-evidence/v1", [{ role: "fact-verification-context", hash: sha(verificationContext), chars: JSON.stringify(verificationContext).length, itemCount: verificationContext.evidenceSegments.length }]));
  const verification = ClaimVerificationSchema.parse(verificationResult.value);
  const parsedFactPack = FactPackSchema.parse(factPack);
  assertClaimVerificationComplete(verification, parsedFactPack);
  for (const entry of verification.evidence) {
    const claim = parsedFactPack.claims.find((candidate) => candidate.id === entry.claimId)!;
    sourceEvidenceSegments(evidenceMap, [{ sourceId: entry.sourceId, sourceHash: claim.evidence.sourceHash, segmentIds: entry.segmentIds }]);
  }
  const claimRows = parsedFactPack.claims.map((claim) => ({ runId, sourceId: claim.evidence.sourceId, claim: claim.text, locator: claim.evidence.locator, evidence: claim.evidence, critical: claim.critical, verifiedAt: new Date(), verifierModel: verificationRun.route.model }));
  if (claimRows.length && !(await getDb().select({ id: sourceClaims.id }).from(sourceClaims).where(eq(sourceClaims.runId, runId))).length) await getDb().insert(sourceClaims).values(claimRows);
  return saveArtifact({ runId, stage: "fact-verification", role: "fact-verification", schemaVersion: "fact-verification/v2", inputHash: sha(factPack), content: verification });
};