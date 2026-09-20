# WF1 — Standard school lesson (photosynthesis) end-to-end

## Scenario
A standard school science request, "How photosynthesis works", with a supplied
TXT source, runs the full 16-stage chain and produces a completed release record
with automated standard school/college approval (no AI illustration selected).

## Inputs → artifacts → handoffs
| Stage | Locked input | Emitted artifact | Gate |
| --- | --- | --- | --- |
| s01 preflight | run snapshot | `capability-report/v1` | capability preflight |
| s02 research | frozen snapshot + source | `source-evidence-map/v1`, `fact-pack/v2` | claim-to-source completeness |
| s03 fact-verification | fact-pack + evidence-map | `claim-verification/v2` | independent claim check |
| s04 blueprint | fact-pack | `lesson-blueprint/v2` | learning-objective coverage |
| s05 script | blueprint + fact-pack | `approved-script/v2` | independent script verification |
| s06 visual-bible | approved-script | `visual-bible/v1` | continuity/safe-area lock |
| s07 assets | script + bible | `selected-assets/v1` (+ `diagram-model/v1`) | deterministic diagram + PNG gate |
| s08 voiceover | approved-script | `voiceover/v1` | audio/alignment checks |
| s09 captions | voiceover | `caption-timings/v1` | word-alignment reconstruction |
| s10 spatial-layout | script + bible + assets | `resolved-layout/v1` | solver assertions |
| s11 manifest | voiceover + captions + layout + … | `video-manifest/v1` | voice-alignment match |
| s12 preview-render | manifest + voiceover + assets | `preview-render/v1` | render-integrity probe |
| s13 qa | preview + manifest + fact-pack + script + layout + assets | `qa-report/v1` | Tier A + Tier B convergence |
| s14 approval | qa-report + preview | (approvals row) | Tier C / automatic standard |
| s15 final-render | manifest + voiceover + assets | `final-render/v1` (+ SRT, variants) | render-integrity probe |
| s16 release-record | final + manifest + qa | `release-record/v1` | required fields + approval |

## Assertions (`run.ts`)
- every required artifact present with a stable sha256 and input hash chain;
- exactly 7 model calls + 1 TTS call (1 planning×4, 1 verifier×2, 1 Tier B, 1 TTS);
- exactly one Tier B call;
- automated approval recorded for standard school/college with no illustration;
- full cost ledger priced from the same `estimateCostMicrounits` math;
- final run status `completed`.

## Run
```bash
node test/pipeline/workflows/wf1-standard-school/run.ts
```
Blocked stages (missing credential) are reported visibly; the workflow is only
`passed` when the run reaches `completed`.
