import { VerifiedFactPackSchema, type ApprovedScript, type Claim, type ClaimVerification, type FactPack, type ScriptVerification, type VerifiedFactPack } from "@upcraft/contracts";

/**
 * Pure reducers over separately routed verification output. A generator must
 * never be the sole authority on its own artifact, so these checks are the
 * deterministic gate that decides whether a verified fact pack or script may
 * advance.
 *
 * The claim policy is repair-first, drop-on-exhaustion: critical unsupported
 * claims are sent to a targeted repair prompt and can never be dropped (critical
 * exhaustion fails the run terminally); non-critical unsupported claims are
 * repaired in the same bounded loop and, only at exhaustion, dropped with a
 * recorded omission on `verified-fact-pack/v1`.
 */
export const unsupportedClaimIds = (verification: ClaimVerification) =>
  verification.evidence.filter((entry) => !entry.supported).map((entry) => entry.claimId);

export const assertClaimVerificationComplete = (verification: ClaimVerification, factPack: FactPack) => {
  const claims = factPack.claims;
  const evaluated = verification.evidence;
  if (evaluated.length !== claims.length || new Set(evaluated.map((entry) => entry.claimId)).size !== claims.length || claims.some((claim) => !evaluated.some((entry) => entry.claimId === claim.id))) {
    throw new Error("Independent verification did not check every fact-pack claim exactly once");
  }
  for (const entry of evaluated) {
    const claim = claims.find((candidate) => candidate.id === entry.claimId);
    if (!claim || claim.evidence.sourceId !== entry.sourceId) throw new Error(`Independent verification changed evidence identity for claim ${entry.claimId}`);
  }
  const unsupported = unsupportedClaimIds(verification);
  if (unsupported.length) throw new Error(`Independent verification rejected claims: ${unsupported.join(", ")}`);
};

export const assertScriptVerificationComplete = (verification: ScriptVerification, script: ApprovedScript) => {
  const lines = script.narration;
  const evaluated = verification.evidence;
  if (evaluated.length !== lines.length || new Set(evaluated.map((entry) => entry.lineId)).size !== lines.length || lines.some((line) => !evaluated.some((entry) => entry.lineId === line.id))) {
    throw new Error("Independent script verification did not check every script line exactly once");
  }
  if (evaluated.some((entry) => !entry.supported || entry.unsupportedClaimIds.length)) throw new Error("Independent script verification rejected unsupported narration");
};

// --- Gap 1: bounded verifier-rejection loop and correction contract ---

export const MAX_VERIFIER_ATTEMPTS = 3;
export const VERIFIER_REJECTION_EXHAUSTED = "VERIFIER_REJECTION_EXHAUSTED";

/**
 * The correction contract travels with the correction prompt so the generator
 * knows the bounds of a targeted repair: keep the same schema version, preserve
 * every already-accepted id verbatim, and rewrite only the listed rejected ids.
 */
export const CORRECTION_CONTRACT = "Keep the same schema and version; preserve every accepted id verbatim; rewrite only the listed rejected ids.";
export const FACT_PACK_CORRECTION_CONTRACT = "same fact-pack/v2; preserve accepted claim ids verbatim; rewrite only these rejected ids";

export type CorrectionPrompt = {
  attempt: number;
  rejectedIds: string[];
  rationale: string;
  contract: string;
};

export class VerifierRejectionError extends Error {
  public readonly rejectedClaimIds: string[];
  public readonly rejectedLineIds: string[];
  public readonly rationale: string;

  public constructor(params: { rejectedClaimIds?: string[]; rejectedLineIds?: string[]; rationale: string }) {
    const rejectedClaimIds = params.rejectedClaimIds ?? [];
    const rejectedLineIds = params.rejectedLineIds ?? [];
    super(`Independent verification rejected ${[...rejectedClaimIds, ...rejectedLineIds].join(", ") || "artifact"}: ${params.rationale}`);
    this.name = "VerifierRejectionError";
    this.rejectedClaimIds = rejectedClaimIds;
    this.rejectedLineIds = rejectedLineIds;
    this.rationale = params.rationale;
  }

  public get rejectedIds(): string[] {
    return [...this.rejectedClaimIds, ...this.rejectedLineIds];
  }
}

export class VerifierRejectionExhaustedError extends Error {
  public readonly code = VERIFIER_REJECTION_EXHAUSTED;
  public readonly attempts: number;
  public readonly lastRejectedIds: string[];

  public constructor(params: { attempts: number; lastRejectedIds: string[] }) {
    super(`${VERIFIER_REJECTION_EXHAUSTED}: verifier still rejected ${params.lastRejectedIds.join(", ") || "the artifact"} after ${params.attempts} attempts`);
    this.name = "VerifierRejectionExhaustedError";
    this.attempts = params.attempts;
    this.lastRejectedIds = params.lastRejectedIds;
  }
}

/** Claim-level assertion that throws a typed rejection instead of a generic error. */
export const assertClaimVerificationCompleteWithRejection = (verification: ClaimVerification, factPack: FactPack): void => {
  const claims = factPack.claims;
  const evaluated = verification.evidence;
  if (evaluated.length !== claims.length || new Set(evaluated.map((entry) => entry.claimId)).size !== claims.length || claims.some((claim) => !evaluated.some((entry) => entry.claimId === claim.id))) {
    throw new Error("Independent verification did not check every fact-pack claim exactly once");
  }
  for (const entry of evaluated) {
    const claim = claims.find((candidate) => candidate.id === entry.claimId);
    if (!claim || claim.evidence.sourceId !== entry.sourceId) throw new Error(`Independent verification changed evidence identity for claim ${entry.claimId}`);
  }
  const rejected = evaluated.filter((entry) => !entry.supported);
  if (rejected.length) {
    throw new VerifierRejectionError({
      rejectedClaimIds: rejected.map((entry) => entry.claimId),
      rationale: rejected.map((entry) => entry.rationale).join(" | "),
    });
  }
};

/**
 * Reducer over a repaired artifact: reports whether the previously accepted ids
 * survived the rewrite. ID drift is a signal to fully re-verify, never a hard
 * failure — correctness must not depend on the generator keeping ids stable.
 */
export type IdPreservation = {
  preserved: boolean;
  acceptedIds: string[];
  observedIds: string[];
  driftedIds: string[];
  missingIds: string[];
  requiresFullReverification: boolean;
};

export const assertIdPreservation = (acceptedIds: string[], next: { claims: Array<{ id: string }> }): IdPreservation => {
  const accepted = new Set(acceptedIds);
  const observed = next.claims.map((claim) => claim.id);
  const observedSet = new Set(observed);
  const missingIds = acceptedIds.filter((id) => !observedSet.has(id));
  const driftedIds = observed.filter((id) => !accepted.has(id));
  const preserved = missingIds.length === 0 && driftedIds.length === 0;
  return { preserved, acceptedIds: [...acceptedIds], observedIds: observed, driftedIds, missingIds, requiresFullReverification: !preserved };
};

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

/** Builds the correction prompt for the next generator run from the current rejection set. */
export const buildCorrectionPrompt = (params: { nextAttempt: number; rejectedIds: string[]; verification: ClaimVerification }): CorrectionPrompt => ({
  attempt: params.nextAttempt,
  rejectedIds: params.rejectedIds,
  rationale: params.rejectedIds.map((claimId) => params.verification.evidence.find((entry) => entry.claimId === claimId)?.rationale ?? "unsupported").join(" | "),
  contract: FACT_PACK_CORRECTION_CONTRACT,
});

export type PolicyOutcome = "completed" | "rejected-by-verifier" | "exhausted-non-critical-drop";

export type PolicyAttempt = {
  attempt: number;
  outcome: PolicyOutcome;
  rejectedIds: string[];
  rationale: string | null;
  idPreservation: IdPreservation | null;
};

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

// --- Claim-set replacement (no schema migration) ---

/**
 * `source_claims` has no `claim_id` column and no unique key, so an upsert cannot
 * address a row by claim identity. The only safe rewrite is an explicit
 * delete-all-for-run + insert-the-verified-set inside one transaction. Planning it
 * as plain data keeps the decision testable without a database: a later attempt
 * replaces every earlier row and dropped claims produce no orphan rows.
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
