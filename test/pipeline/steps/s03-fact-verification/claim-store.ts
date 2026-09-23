import type { VerifiedFactPack } from "./claim-policy.ts";

/**
 * s03 sandbox — claim-set replacement planner (test-local; promoted at Phase 6).
 *
 * `source_claims` has no `claim_id` column and no unique key, so an upsert cannot
 * address a row by claim identity. The only safe rewrite is an explicit
 * delete-all-for-run + insert-the-verified-set inside one transaction. Planning it
 * as plain data keeps the decision testable without a database: a later attempt
 * replaces every earlier row (no stale/duplicate claims) and dropped claims
 * produce no orphan rows.
 */

export type ClaimInsertRow = {
  runId: string;
  sourceId: string;
  claim: string;
  locator: string;
  evidence: Record<string, unknown>;
  critical: boolean;
  verifiedAt: Date;
  verifierModel: string | null;
};

export type ClaimSetReplacement = {
  runId: string;
  /** Deletes every prior claim row for the run before inserting the new set. */
  deleteWhere: { runId: string };
  insert: ClaimInsertRow[];
  /** Non-critical omissions: recorded on the artifact, never persisted as claim rows. */
  droppedClaimIds: string[];
};

export const planClaimSetReplacement = (
  runId: string,
  verifiedFactPack: VerifiedFactPack,
  verifierModel: string | null,
  options: { verifiedAt?: Date } = {},
): ClaimSetReplacement => {
  const verifiedAt = options.verifiedAt ?? new Date();
  return {
    runId,
    deleteWhere: { runId },
    insert: verifiedFactPack.claims.map((claim) => ({
      runId,
      sourceId: claim.evidence.sourceId,
      claim: claim.text,
      locator: claim.evidence.locator,
      evidence: claim.evidence as unknown as Record<string, unknown>,
      critical: claim.critical,
      verifiedAt,
      verifierModel,
    })),
    droppedClaimIds: verifiedFactPack.omissions.map((omission) => omission.claimId),
  };
};
