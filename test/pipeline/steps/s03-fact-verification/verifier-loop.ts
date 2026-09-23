import type { ClaimVerification, FactPack, ScriptVerification, ApprovedScript } from "@upcraft/contracts";

/**
 * Gap 1 — bounded verifier-rejection loop (test-local first; promoted at Phase 6).
 *
 * Today a verifier that marks any claim/line unsupported throws a generic error.
 * The executor then regenerates the whole artifact through its generic
 * invalid-artifact path, which loses the verifier's rationale and cannot target
 * only the rejected items. This module makes rejection a typed, actionable signal
 * and bounds a correction loop that re-runs only the generator with the exact
 * rejected IDs and rationale, so a single bad claim costs one targeted retry
 * instead of a blind full regeneration.
 *
 * Promoted behavior will live in `packages/pipeline/src/verification.ts` and the
 * s03/s05 stage handlers.
 */

export const MAX_VERIFIER_ATTEMPTS = 3;
export const VERIFIER_REJECTION_EXHAUSTED = "VERIFIER_REJECTION_EXHAUSTED";

export type RejectionRationale = { rejectedIds: string[]; rationale: string };

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

/** Line-level assertion that throws a typed rejection instead of a generic error. */
export const assertScriptVerificationCompleteWithRejection = (verification: ScriptVerification, script: ApprovedScript): void => {
  const lines = script.narration;
  const evaluated = verification.evidence;
  if (evaluated.length !== lines.length || new Set(evaluated.map((entry) => entry.lineId)).size !== lines.length || lines.some((line) => !evaluated.some((entry) => entry.lineId === line.id))) {
    throw new Error("Independent script verification did not check every script line exactly once");
  }
  const rejected = evaluated.filter((entry) => !entry.supported || entry.unsupportedClaimIds.length);
  if (rejected.length) {
    throw new VerifierRejectionError({
      rejectedLineIds: rejected.map((entry) => entry.lineId),
      rationale: rejected.map((entry) => entry.rationale).join(" | "),
    });
  }
};

export type AttemptOutcome = "completed" | "rejected-by-verifier";

export type VerificationAttempt<T> = {
  attempt: number;
  outcome: AttemptOutcome;
  rejectedIds: string[];
  rationale: string | null;
  value?: T;
};

/**
 * The correction contract is part of the correction prompt so the generator
 * knows the bounds of a targeted repair: it must keep the same schema version,
 * preserve every already-accepted id verbatim, and rewrite only the listed
 * rejected ids. `fact-pack/v2` and `approved-script/v2` override the wording but
 * every caller ships a contract.
 */
export const CORRECTION_CONTRACT = "Keep the same schema and version; preserve every accepted id verbatim; rewrite only the listed rejected ids.";

export type CorrectionPrompt = {
  attempt: number;
  rejectedIds: string[];
  rationale: string;
  contract: string;
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

/**
 * Runs generate → verify up to `maxAttempts`. On a typed rejection it re-runs
 * only the generator, passing the exact rejected IDs and rationale. Exhaustion
 * raises `VerifierRejectionExhaustedError`, which is a terminal, visible failure:
 * downstream stages are never scheduled.
 */
export const runBoundedVerifierLoop = async <T>(params: {
  maxAttempts?: number;
  /** Overrides the default correction contract for stage-specific wording. */
  contract?: string;
  generate: (correction: CorrectionPrompt | null) => Promise<T>;
  verify: (value: T) => Promise<void> | void;
  onAttempt?: (attempt: VerificationAttempt<T>) => Promise<void> | void;
}): Promise<{ value: T; attempts: VerificationAttempt<T>[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_VERIFIER_ATTEMPTS;
  const contract = params.contract ?? CORRECTION_CONTRACT;
  const attempts: VerificationAttempt<T>[] = [];
  let correction: CorrectionPrompt | null = null;
  let lastRejectedIds: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await params.generate(correction);
    try {
      await params.verify(generated);
      const record: VerificationAttempt<T> = { attempt, outcome: "completed", rejectedIds: [], rationale: null, value: generated };
      attempts.push(record);
      await params.onAttempt?.(record);
      return { value: generated, attempts };
    } catch (error) {
      if (!(error instanceof VerifierRejectionError)) throw error;
      lastRejectedIds = error.rejectedIds;
      const record: VerificationAttempt<T> = { attempt, outcome: "rejected-by-verifier", rejectedIds: error.rejectedIds, rationale: error.rationale };
      attempts.push(record);
      await params.onAttempt?.(record);
      correction = { attempt: attempt + 1, rejectedIds: error.rejectedIds, rationale: error.rationale, contract };
    }
  }

  throw new VerifierRejectionExhaustedError({ attempts: maxAttempts, lastRejectedIds });
};