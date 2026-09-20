import type { ApprovedScript, ScriptVerification } from "@upcraft/contracts";
import {
  assertScriptVerificationCompleteWithRejection,
  runBoundedVerifierLoop,
  VerifierRejectionError,
  VerifierRejectionExhaustedError,
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  type CorrectionPrompt,
  type VerificationAttempt,
} from "../s03-fact-verification/verifier-loop.ts";

/**
 * Gap 1 for the script stage (test-local first; promoted at Phase 6).
 *
 * The generic bounded loop lives with the fact-verification stage because that is
 * where it was first needed; this module specializes it for `approved-script/v2`
 * lines so the script stage re-runs only the script generator with the exact
 * rejected line ids and rationale. It is co-located here, not in a separate
 * patches folder, so the promotion edit is stage-local.
 */
export {
  VerifierRejectionError,
  VerifierRejectionExhaustedError,
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  assertScriptVerificationCompleteWithRejection,
};
export type { CorrectionPrompt, VerificationAttempt };

export const runBoundedScriptVerifierLoop = async (params: {
  maxAttempts?: number;
  generate: (correction: CorrectionPrompt | null) => Promise<ApprovedScript>;
  verify: (script: ApprovedScript) => Promise<void> | void;
  onAttempt?: (attempt: VerificationAttempt<ApprovedScript>) => Promise<void> | void;
}) => runBoundedVerifierLoop<ApprovedScript>(params);

export { assertScriptVerificationCompleteWithRejection as assertScriptVerification };

/** Records an attempt against the usage ledger shape the harness asserts on. */
export type ScriptAttemptRecord = { attempt: number; outcome: string; rejectedIds: string[] };

export const scriptVerificationIssues = (verification: ScriptVerification): string[] =>
  verification.evidence.filter((entry) => !entry.supported || entry.unsupportedClaimIds.length).map((entry) => entry.lineId);