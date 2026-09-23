import { z } from "zod";
import { ClaimSchema, SourceEvidenceRefSchema, type Claim, type ClaimVerification, type FactPack } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VerifierRejectionExhaustedError,
  assertIdPreservation,
  type CorrectionPrompt,
  type IdPreservation,
} from "./verifier-loop.ts";

/**
 * s03 sandbox — repair-first, drop-on-exhaustion claim policy (test-local; promoted at Phase 6).
 *
 * Confirmed policy:
 *   - critical unsupported  → repair prompt; if still unsupported at exhaustion
 *                             the run fails visibly (`VERIFIER_REJECTION_EXHAUSTED`)
 *                             and the claim is NEVER dropped.
 *   - non-critical unsupported → repair prompt too (one bounded loop); if still
 *                             unsupported at exhaustion it is dropped and recorded
 *                             as an omission on `verified-fact-pack/v1`.
 *
 * `classifyVerification` is the pure policy reducer; `buildVerifiedFactPack` is the
 * typed release artifact; `runClaimVerificationPolicyLoop` wires both to a bounded
 * generate → verify loop that costs one generator re-run per repair round instead
 * of one full regeneration per rejected item.
 */

export const VERIFIED_FACT_PACK_SCHEMA = "verified-fact-pack/v1";
export const FACT_PACK_CORRECTION_CONTRACT = "same fact-pack/v2; preserve accepted claim ids verbatim; rewrite only these rejected ids";

export const VerifiedFactPackSchema = z.object({
  schemaVersion: z.literal("verified-fact-pack/v1"),
  claims: z.array(ClaimSchema),
  caveats: z.array(z.object({ text: z.string().min(1), evidence: SourceEvidenceRefSchema.optional() })),
  omissions: z.array(z.object({
    claimId: z.string().uuid(),
    text: z.string().min(1),
    rationale: z.string().min(1),
    attempts: z.number().int().positive(),
  })),
  attempts: z.number().int().positive(),
  verifierModel: z.string().min(1).nullable(),
});
export type VerifiedFactPack = z.infer<typeof VerifiedFactPackSchema>;

export type VerificationClassification = {
  /** Claims the verifier accepted; these advance unchanged. */
  verifiedClaims: Claim[];
  /** Every rejected claim id sent to the targeted repair prompt, critical and non-critical. */
  repairClaimIds: string[];
  /** Non-critical rejected ids that become omissions at exhaustion. */
  dropCandidates: string[];
  /** Critical rejected ids: never droppable, so exhaustion is terminal. */
  criticalRejections: string[];
  /** Non-critical rejected ids (the drop channel). */
  nonCriticalRejections: string[];
};

export const classifyVerification = (verification: ClaimVerification, factPack: FactPack): VerificationClassification => {
  const byClaim = new Map(verification.evidence.map((entry) => [entry.claimId, entry]));
  const verifiedClaims: Claim[] = [];
  const repairClaimIds: string[] = [];
  const criticalRejections: string[] = [];
  const nonCriticalRejections: string[] = [];

  for (const claim of factPack.claims) {
    const entry = byClaim.get(claim.id);
    if (entry?.supported) {
      verifiedClaims.push(claim);
      continue;
    }
    repairClaimIds.push(claim.id);
    if (claim.critical) criticalRejections.push(claim.id);
    else nonCriticalRejections.push(claim.id);
  }

  return { verifiedClaims, repairClaimIds, dropCandidates: nonCriticalRejections, criticalRejections, nonCriticalRejections };
};

/**
 * Materializes the release artifact. A surviving critical rejection is terminal —
 * it can never be represented as an omission — while surviving non-critical
 * rejections are recorded with their rationale and attempt count.
 */
export const buildVerifiedFactPack = (
  factPack: FactPack,
  verification: ClaimVerification,
  options: { attempts: number; verifierModel?: string | null },
): VerifiedFactPack => {
  const classification = classifyVerification(verification, factPack);
  if (classification.criticalRejections.length) {
    throw new VerifierRejectionExhaustedError({ attempts: options.attempts, lastRejectedIds: classification.criticalRejections });
  }
  const byClaim = new Map(verification.evidence.map((entry) => [entry.claimId, entry]));
  const claimsById = new Map(factPack.claims.map((claim) => [claim.id, claim]));
  const omissions = classification.nonCriticalRejections.map((claimId) => ({
    claimId,
    text: claimsById.get(claimId)!.text,
    rationale: byClaim.get(claimId)!.rationale,
    attempts: options.attempts,
  }));
  return VerifiedFactPackSchema.parse({
    schemaVersion: "verified-fact-pack/v1",
    claims: classification.verifiedClaims,
    caveats: factPack.caveats,
    omissions,
    attempts: options.attempts,
    verifierModel: options.verifierModel ?? null,
  });
};

export type PolicyOutcome = "completed" | "rejected-by-verifier" | "exhausted-non-critical-drop";

export type PolicyAttempt = {
  attempt: number;
  outcome: PolicyOutcome;
  rejectedIds: string[];
  rationale: string | null;
  idPreservation: IdPreservation | null;
};

/** Builds the correction prompt for the next generator run from the current rejection set. */
export const buildCorrectionPrompt = (params: { nextAttempt: number; rejectedIds: string[]; verification: ClaimVerification }): CorrectionPrompt => ({
  attempt: params.nextAttempt,
  rejectedIds: params.rejectedIds,
  rationale: params.rejectedIds.map((claimId) => params.verification.evidence.find((entry) => entry.claimId === claimId)?.rationale ?? "unsupported").join(" | "),
  contract: FACT_PACK_CORRECTION_CONTRACT,
});

/**
 * Bounded generate → verify loop under the confirmed policy. Returns the verified
 * fact pack on success or on a non-critical exhaustion drop; throws the terminal
 * `VerifierRejectionExhaustedError` when a critical claim survives exhaustion.
 */
export const runClaimVerificationPolicyLoop = async (params: {
  factPack: FactPack;
  maxAttempts?: number;
  generate: (correction: CorrectionPrompt | null) => Promise<FactPack>;
  verify: (factPack: FactPack, attempt: number) => Promise<ClaimVerification> | ClaimVerification;
  verifierModel?: string | null;
  onAttempt?: (attempt: PolicyAttempt) => Promise<void> | void;
}): Promise<{ verifiedFactPack: VerifiedFactPack; attempts: PolicyAttempt[]; droppedClaimIds: string[]; verification: ClaimVerification }> => {
  const maxAttempts = params.maxAttempts ?? MAX_VERIFIER_ATTEMPTS;
  const attempts: PolicyAttempt[] = [];
  let correction: CorrectionPrompt | null = null;
  let acceptedIds: string[] = [];
  let verification: ClaimVerification | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pack = await params.generate(correction);
    const idPreservation = correction ? assertIdPreservation(acceptedIds, pack) : null;
    verification = await params.verify(pack, attempt);
    const classification = classifyVerification(verification, pack);

    if (classification.repairClaimIds.length === 0) {
      const verifiedFactPack = buildVerifiedFactPack(pack, verification, { attempts: attempt, verifierModel: params.verifierModel ?? null });
      const record: PolicyAttempt = { attempt, outcome: "completed", rejectedIds: [], rationale: null, idPreservation };
      attempts.push(record);
      await params.onAttempt?.(record);
      return { verifiedFactPack, attempts, droppedClaimIds: [], verification };
    }

    const isLast = attempt === maxAttempts;
    const dropsAtExhaustion = isLast && classification.criticalRejections.length === 0;
    const rationale = classification.repairClaimIds.map((claimId) => verification!.evidence.find((entry) => entry.claimId === claimId)?.rationale ?? "unsupported").join(" | ");
    const record: PolicyAttempt = {
      attempt,
      outcome: dropsAtExhaustion ? "exhausted-non-critical-drop" : "rejected-by-verifier",
      rejectedIds: classification.repairClaimIds,
      rationale,
      idPreservation,
    };
    attempts.push(record);
    await params.onAttempt?.(record);

    if (isLast) {
      if (classification.criticalRejections.length) {
        throw new VerifierRejectionExhaustedError({ attempts: attempt, lastRejectedIds: classification.criticalRejections });
      }
      const verifiedFactPack = buildVerifiedFactPack(pack, verification, { attempts: attempt, verifierModel: params.verifierModel ?? null });
      return { verifiedFactPack, attempts, droppedClaimIds: classification.nonCriticalRejections, verification };
    }

    acceptedIds = classification.verifiedClaims.map((claim) => claim.id);
    correction = buildCorrectionPrompt({ nextAttempt: attempt + 1, rejectedIds: classification.repairClaimIds, verification });
  }

  throw new VerifierRejectionExhaustedError({ attempts: maxAttempts, lastRejectedIds: [] });
};
