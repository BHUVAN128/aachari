# s03 — Fact verification: iteration log

## Scope
Runs the real `runFactVerification` handler through the `fact-verification`
capability route (`gemini/gemini-3.8-flash`, fallback `openai/gpt-5.6-terra`).
Consumes frozen `source-evidence-map` + `fact-pack`; emits `claim-verification/v2`.

## Corrections applied
- **Gap 1 (bounded verifier-rejection loop), test-local first.** Today a rejected
  claim throws a generic error and the executor regenerates the whole artifact
  through its generic invalid-artifact path, losing the verifier rationale and
  re-running the full generator. `verifier-loop.ts` here defines
  `VerifierRejectionError` (with exact rejected claim ids + rationale),
  `assertClaimVerificationCompleteWithRejection`, and
  `runBoundedVerifierLoop` (max 3 attempts, correction-prompt channel, terminal
  `VERIFIER_REJECTION_EXHAUSTED`). It is reused by s05. Promoted at Phase 6 into
  `packages/pipeline/src/verification.ts` and the s03/s05 handlers.

## Assertions
- accept-after-correction: verifier rejects C-3 once → attempt 2 corrected →
  sequence `rejected-by-verifier → completed`.
- exhaustion: verifier rejects all attempts → terminal
  `VerifierRejectionExhaustedError` with code `VERIFIER_REJECTION_EXHAUSTED`.
- every attempt is reported so the NDJSON ledger can prove the sequence.

## Status
- [x] Gap 1 deterministic tests green
- [ ] real verifier run green (needs GEMINI_API_KEY)
