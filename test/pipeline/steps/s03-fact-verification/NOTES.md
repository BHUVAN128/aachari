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

## Verification hardening (repair-first, drop-on-exhaustion)
Confirmed policy: critical unsupported claims are repaired and can never be
dropped; a critical claim still unsupported at exhaustion fails the run terminally
(`VERIFIER_REJECTION_EXHAUSTED`). Non-critical unsupported claims are repaired once
in the same bounded loop, and are dropped with a recorded omission only at
exhaustion.

- **A1 `claim-policy.ts`.** `classifyVerification` returns the repair channel (all
  rejected ids), the drop candidates (non-critical), and the critical rejections.
  `buildVerifiedFactPack` emits `verified-fact-pack/v1` with `omissions[]`
  (claim id + text + verifier rationale + attempt count) and throws the terminal
  error on a surviving critical rejection. `runClaimVerificationPolicyLoop` wires
  the policy to the bounded loop. A 24/25 mixed pack now costs exactly 2 generator
  runs (one repair round), not one full regeneration per rejected claim.
- **A2 `context-window.ts`.** `withEvidenceWindow` adds ±1 ordinal neighbours from
  the same source, tags every segment `cited: true|false`, orders deterministically,
  and enforces a hard character budget. Cited segments are always included whole;
  a neighbour that does not fit is omitted and counted — source text is never
  truncated. Removes the verification bias that judged a cited sentence alone.
- **A3 `json-extraction.ts`.** `parseVerifierJson` strips a fenced wrapper, extracts
  the single balanced JSON object, and throws on malformed or ambiguous payloads.
  Transport normalization only; it never repairs syntax.
- **A4 `claim-store.ts`.** `planClaimSetReplacement` plans an explicit
  delete-all-for-run + insert-verified-set transaction. `source_claims` has no
  `claim_id` column, so this replaces attempt-1 rows when attempt-2 ids change and
  leaves no orphan rows for dropped claims.
- **A5 `verifier-loop.ts`.** `CorrectionPrompt` now carries a `contract`
  ("preserve accepted ids verbatim; rewrite only the rejected ids").
  `assertIdPreservation` reports drift and forces full re-verification instead of
  failing, so correctness never depends on generator ID stability.

## Assertions
- accept-after-correction: verifier rejects C-3 once → attempt 2 corrected →
  sequence `rejected-by-verifier → completed`.
- exhaustion: verifier rejects all attempts → terminal
  `VerifierRejectionExhaustedError` with code `VERIFIER_REJECTION_EXHAUSTED`.
- policy: channels; non-critical exhaustion drops with omission; critical
  exhaustion terminal; 24/25 mixed pack = 2 generator runs.
- context window: neighbours pulled in-source; cross-source isolated; budget
  respected with omitted-neighbour accounting.
- JSON extraction: fenced / trailing commentary / clean parsed; malformed and
  ambiguous throw.
- claim-set replacement: attempt-2 rows replace attempt-1; dropped claim leaves no
  orphan row.

## Status
- [x] Gap 1 deterministic tests green
- [x] Verification-hardening (A1–A5) deterministic tests green
- [ ] real verifier run green (needs GEMINI_API_KEY)
