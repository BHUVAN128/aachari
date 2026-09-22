# Step Harness — Status Tracker

Check a box **only** when the step's `logs/<runId>/<step>.ndjson` shows the
expected outcome sequence from a real, unblocked run, and its `test.ts` passes.

## Pipeline steps

| # | Step | Assertions | Live run |
| --- | --- | --- | --- |
| s00 | intake-hardening | code-owned defaults; bounded context projection; domain-validation fallback; classified retry+backoff; pricing stamping; medical-as-standard input | [ ] |
| s01 | preflight | capability report emitted; missing credentials fail visibly; frozen-source screening; privacy gate; provenance validation; cost ceiling + idempotent run identity; compliance-report/v1 | [ ] |
| s02 | research | lossless evidence map; fact-pack schema/contract; claims cite locked segments | [x] |
| s03 | fact-verification | verifier rejects once then accepts (WF2); exhaustion fails visibly | [ ] |
| s04 | blueprint | blueprint schema; objective coverage; critical-claim coverage | [ ] |
| s05 | script | script schema; verifier loop; `pauseMs` pacing present | [ ] |
| s06 | visual-bible | visual-bible schema; safe-area fractions | [ ] |
| s07 | assets | typed diagram models; PNG-only illustration gate; omission fallback | [ ] |
| s08 | voiceover | measured duration ≥ speech + pauses; loudness/pronunciation gates | [ ] |
| s09 | captions | caption cues reconstruct locked word alignment | [ ] |
| s10 | spatial-layout | solver assertions; drift ≤ 0.75px; no caption overlap | [ ] |
| s11 | manifest | manifest schema; voice alignment matches script lines | [ ] |
| s12 | preview-render | render-integrity probe from produced bytes | [ ] |
| s13 | qa | Tier A deterministic + exactly one Tier B call; convergence | [ ] |
| s14 | approval | automatic standard school/college path; illustration forces review | [ ] |
| s15 | final-render | final master + SRT + variants; export profile | [ ] |
| s16 | release-record | required release fields; completed status | [ ] |

Current green frontier: **s02**. s02's Gap-3 module is test-local and is promoted
to `packages/pipeline` at Phase 6.

## Gap fixes

| Gap | Where it lives now | Promoted to | Deterministic tests | Promoted |
| --- | --- | --- | --- | --- |
| Gap 3 semantic segmentation | `steps/s02-research/segmentation.ts` | `packages/pipeline/src/context.ts` | [x] | [ ] |
| Gap 1 verifier-rejection loop | `steps/s03-fact-verification/verifier-loop.ts`, `steps/s05-script/script-verification.ts` | `packages/pipeline/src/verification.ts` + s03/s05 | [x] | [ ] |
| Gap 4 transport hardening | `steps/s02-research/transport-hardening.ts` | `packages/providers/src/errors.ts`, `openai.ts`, `gemini.ts`, `elevenlabs.ts` | [x] | [ ] |
| Gap 2 visual pacing | `steps/s05-script/pacing.ts`, `steps/s08-voiceover/line-synthesis.ts` | `prompts/script.ts`, `providers/elevenlabs.ts`, `contracts` | [x] | [ ] |

## Workflows

| Workflow | Scenario | Deterministic path | Live path |
| --- | --- | --- | --- |
| WF1 standard school | photosynthesis → 16 stages → completed release record | n/a | [ ] |
| WF2 verifier rejection | one claim rejected then accepted; exhaustion variant | [x] | [ ] |
| WF3 transport recovery | truncation retry; hang fallback; crash-before-checkpoint resume | [x] | [ ] |

## Promotion gate (Phase 6)
- [ ] all step boxes ticked
- [ ] gap modules ported to `packages/`
- [ ] `packages/*/test` regression suites pass
- [ ] governing-doc updates committed in the same change
- [ ] harness retained under `test/` as the sandbox

## Smarter intake + web research + medical deprecation

| Area | Regression | Status |
| --- | --- | --- |
| Intake v2 configuration extraction (duration expression, level, aspect ratio, selected-language preservation) | `packages/providers/test/intake-policy.test.ts` | [x] |
| Web-research transport and provenance parsing | `packages/providers/test/websearch.test.ts` | [x] |
| Source-less run → web source rows → valid evidence map | `packages/pipeline/test/research-web.test.ts` | [x] |
| Research-web model route assertion | `packages/pipeline/test/model-route.test.ts` | [x] |
| Medical domain/clinician removal (domain, DB, approvals, capabilities) | `packages/pipeline/test/domain-qa.test.ts`, `approvals-policy.test.ts` | [x] |

## Preflight hardening (s01 — sandbox, post-freeze)

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| R1 frozen-source screening (denylist + injectable model classifier) | `setup/preflight-hardening/screening.ts` | [x] | [ ] | [ ] |
| R2 privacy / secret scan (counts + hashes only) | `setup/preflight-hardening/privacy.ts` | [x] | n/a | [ ] |
| R3 provenance validation (kind/name/hash, HTTPS URLs, rights flagged) | `setup/preflight-hardening/provenance.ts` | [x] | n/a | [ ] |
| R4 cost ceiling + run-identity uniqueness | `setup/preflight-hardening/fraud-controls.ts` | [x] | n/a | [ ] |
| R5 typed compliance evidence (`compliance-report/v1`) | `setup/preflight-hardening/compliance-report.ts` | [x] | n/a | [ ] |
| Harness runner applying the guards to the frozen snapshot | `setup/preflight-runner.ts` | [x] | [ ] | n/a |

Promotion (Phase 6) folds screening into the production `runPreflight` before s02
is scheduled, moves run-identity uniqueness into `createVideoRun`, and carries
`packages/*` regression suites plus any governing-doc updates in the same change.

## Intake hardening (s00 — sandbox, pre-run)

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| 1A broken medical-adjacent input | `setup/inputs.ts` | [x] | n/a | n/a (harness-only) |
| 1B code-owned defaults | `packages/pipeline/src/intake-normalize.ts` | [x] | [ ] | [x] |
| 1C bounded context projection | `packages/pipeline/src/intake-projection.ts` | [x] | [ ] | [x] |
| 1D domain-validation fallback | `packages/pipeline/src/domain-routing.ts` | [x] | [ ] | [x] |
| 1E classified retry + backoff | `packages/pipeline/src/pipeline/intake-retry.ts` | [x] | [ ] | [x] |
| 1F usage/pricing stamping | `packages/providers/src/safety.ts`, `packages/pipeline/src/intake.ts` | [x] | [ ] | [x] |
| 1G payload hygiene (no `sourceIds`) | `packages/contracts` (`CreateRunInputSchema`) | [x] | n/a | [x] |
| 2A complexity + derived duration (approved) | `packages/pipeline/src/intake-normalize.ts`, contracts `IntakeBriefV3` | [x] | [ ] | [x] |
| 2B content moderation gate (approved) | `packages/providers/src/safety.ts`, `packages/pipeline/src/intake.ts` | [x] | [ ] | [x] |
| 2C domain taxonomy expansion (approved) | contracts `DomainSchema`, `packages/db` migration `0008`, `domain-routing.ts` | [x] | [ ] | [x] |
| 3x intake clarification loop | `setup/intake-hardening/clarification.ts`, `setup/intake-runner.ts` | [x] | [ ] | [ ] |

Phase 2 items were explicitly approved by the user and promoted in the same
change as their governing-document updates (`video-generation-process.md`,
`benchmarkstofocus.md`, `model-recommendations.md`). Production regression tests
live in `packages/providers/test/intake-policy.test.ts`,
`packages/providers/test/model-config.test.ts`, and
`packages/pipeline/test/intake.test.ts`. The make-version schemas and migration
require a live database/provider to run end-to-end (still marked Live `[ ]`).

3x is sandbox-only: `intake-clarification/v1` adds a bounded, stateful
clarification loop (`needs_input` result, code-written unparseable question,
injectable model assessor for ambiguous requests, post-brief topic scrub). It
edits no `packages/`/`apps/`/`docs/` file. Promotion is a separate user-approved
change that adds `needs_input` to `IntakeSessionStatusSchema`, wires the real
assessor route (reusing `intake-brief`, no new model route), builds the web
option/mic UI, and lands the `benchmarkstofocus.md` gate rows.
