# WF2 — Verifier rejection and correction

## Scenario
The independent verifier rejects exactly one claim (`C-3`) once. The bounded loop
re-runs only the generator with the exact rejected id and rationale; the corrected
fact pack is accepted on attempt 2. A second variant rejects every attempt and the
run ends in a terminal `VERIFIER_REJECTION_EXHAUSTED` with no downstream stage
scheduled.

## Expected ledger sequence
| Attempt | Outcome |
| --- | --- |
| 1 | `rejected-by-verifier` (C-3) |
| 2 | `completed` |

Exhaustion variant:
| Attempt | Outcome |
| --- | --- |
| 1..3 | `rejected-by-verifier` |
| terminal | `VERIFIER_REJECTION_EXHAUSTED` |

## Assertions (`run.ts`)
- correction prompt carries exactly the rejected id(s) and the verifier rationale;
- the generator runs once per rejected attempt and no more;
- accept-after-correction completes with two logged attempts;
- exhaustion raises the typed terminal error and never promotes an artifact.

## Run
```bash
node test/pipeline/workflows/wf2-verifier-rejection/run.ts
```
Gap 1 is test-local (`steps/s03-fact-verification/verifier-loop.ts`) and is
promoted to `packages/pipeline/src/verification.ts` at Phase 6.
