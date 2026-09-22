# s01 — Preflight guardrails & safety gate: iteration log

## Scope
`s01-preflight` is the last zero-token, zero-billing chokepoint after the intake
snapshot is frozen and before s02 schedules any billable provider call. The
production handler (`packages/pipeline/src/pipeline/stages/s01-preflight.ts`)
still only asserts capabilities and storage.

s00's content-moderation gate only sees the bounded `requestText`, before a run
exists, so the frozen snapshot's user-supplied source documents and configuration
were never screened. This sandbox step adds the missing guardrails as
sandbox-local modules under `test/pipeline/setup/preflight-hardening/`, applied by
`setup/preflight-runner.ts`. Nothing here modifies production code — promotion is
a separate Phase-6 change.

## Risk register → guardrail
| # | Legal risk | Guardrail | Evidence |
| --- | --- | --- | --- |
| R1 | Illegal/abusive source content, jailbreak injection | `screening.ts`: deterministic denylist (reject-only) + injectable model classifier over the approved `safety-classification` route | category hits, verdict, terminal code |
| R2 | Privacy (GDPR / DPDP): PII/secrets to third-party providers | `privacy.ts`: email/phone/card(Luhn)/API-key/secret/IBAN detectors; counts + SHA-256 hashes only | `privacy.findings` |
| R3 | Copyright/IP: unattributed or non-HTTPS sources | `provenance.ts`: kind/name/hash required; URL sources must be HTTPS with a recorded origin; rights flagged | `provenance[]` |
| R4 | Billing fraud / duplicate double-billing | `fraud-controls.ts`: deterministic cost ceiling from resolved routes + snapshot; run-identity uniqueness assertion | `costCeiling`, `idempotency` |
| R5 | Run integrity | `compliance-report/v1` records the snapshot hash the gate evaluated | `snapshotHash` |

## Design
1. **Sandbox-first.** All code lives under `test/pipeline/`; the production
   `runPreflight` is invoked unmodified through `runStage()`.
2. **Deterministic-first, zero tokens.** The default gates are offline
   regex/structure checks. The model classifier is injectable and reuses the
   already-approved `safety-classification` route (`SAFETY_ROUTE`, re-exported
   from the s00 module so there is one route of truth).
3. **Denylist may only reject.** Terminal codes (`safety_policy_rejected`,
   `safety_review_required`, `privacy_blocked`, `provenance_incomplete`,
   `duplicate_run`) are never retried and block before s02 schedules a billable
   call.
4. **No raw private data in telemetry/artifacts.** Screening and privacy records
   carry category names, counts, and SHA-256 hashes only. A blocked run sets a
   terminal `failed` status and makes zero provider calls.
5. **Contract-driven.** `compliance-report/v1` is schema-validated by the existing
   `setup/contract.ts` grammar via `expected-compliance-output.json`.

## Deviations from the draft plan
- The report field for per-source screening records is named `screening`, not
  `sources`, because `sources` is a forbidden key in the production telemetry
  guard (`packages/pipeline/src/telemetry.ts`). The semantics are unchanged.
- `illustration` routes are recorded `unpriced: true` rather than priced with the
  text token rate: no image price is registered, so a token estimate would be a
  fabricated number.

## Assertions
- R1: benign + educational-medical text passes; the hostile fixture blocks with
  `safety_policy_rejected`; the model classifier validates against the shared
  schema and reuses `SAFETY_ROUTE`; `screenSources` screens every source.
- R2: Luhn-valid card detects, failing Luhn does not; email/phone/card/api-key/
  secret detect; serialized scan contains no raw value; credentials block while
  contact PII records.
- R3: complete provenance passes with `rightsDeclaration: unrecorded`; non-HTTPS
  URL fails with `http-insecure`; missing name/hash fails; the raw URL is not
  duplicated into the record.
- R4: cost ceiling stamps `pricingVersion`, marks unpriced routes explicitly,
  omits web research for source-backed runs and includes it when source-less;
  run identity keys are order-independent; a duplicate frozen input is detected.
- Compliance: the gate returns `duplicate_run` for a non-unique identity;
  `compliance-report/v1` satisfies its contract.
- Runner: benign photosynthesis passes compliance with 0 provider calls; the
  hostile fixture is blocked with a terminal `failed` run and 0 provider calls;
  the live capability preflight runs when credentials exist and is BLOCKED
  otherwise.

## Status
- [x] deterministic tests green (no provider keys required)
- [x] compliance-report contract green
- [ ] live capability preflight green (needs planning/verification/research/voice +
      storage credentials)
