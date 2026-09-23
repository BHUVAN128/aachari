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
| s04 | blueprint | blueprint schema; objective coverage; critical-claim coverage; scene-density guard; critical-claim budget; visual-beat validation; bounded QA repair loop; composite input hash | [ ] |
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
| Gap 3 semantic segmentation | `packages/pipeline/src/context.ts` | `packages/pipeline/src/context.ts` | [x] | [x] |
| Gap 1 verifier-rejection loop | `steps/s03-fact-verification/verifier-loop.ts`, `steps/s05-script/script-verification.ts` | `packages/pipeline/src/verification.ts` + s03/s05 | [x] | [x] |
| Gap 4 transport hardening | `steps/s02-research/transport-hardening.ts` | `packages/providers/src/errors.ts`, `openai.ts`, `gemini.ts`, `elevenlabs.ts` | [x] | [ ] |
| Gap 2 visual pacing | `steps/s05-script/pacing.ts`, `steps/s08-voiceover/line-synthesis.ts` | `prompts/script.ts`, `providers/elevenlabs.ts`, `contracts` | [x] | [ ] |

## Alignment, curation, language & caption hardening (W1–W5 — sandbox)

Sandbox-first hardening for the voiceover/caption/language defects found while
tracing s05–s13. Deterministic tests run with `node test/pipeline/steps/<step>/test.ts`;
promotion to `packages/` plus the governing-doc updates is a separate, explicit
user-approved change (Phase 6 style).

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| W2 s08 pre-save alignment integrity gate + bounded re-synthesis (deadlock fix) | `steps/s08-voiceover/alignment-gate.ts` | [x] | [ ] | [ ] |
| W1 shared curated-term derivation (verified-pack terms, narration priority) + voice-aware voiceover input hash | `steps/s08-voiceover/curated-terms.ts` | [x] | [ ] | [ ] |
| W3 English `visualAction` directive + s06 entity-description language gate (bounded repair) | `steps/s05-script/language-directive.ts` | [x] | [ ] | [ ] |
| W4 caption safe-area bound + true per-scene caption zone + width-aware cue packing + one-diagram-per-scene invariant | `steps/s10-spatial-layout/caption-zone.ts` | [x] | [ ] | [ ] |
| W5 break-tag pause execution + measured-gap gate | `steps/s08-voiceover/line-synthesis.ts` | [x] | [ ] | [ ] |

Deterministic suites: `steps/s08-voiceover/test.ts`, `steps/s05-script/test.ts`,
`steps/s10-spatial-layout/caption-zone.test.ts`; harness type gate
`npx tsc -p test/pipeline/tsconfig.json`.

## Workflows

| Workflow | Scenario | Deterministic path | Live path |
| --- | --- | --- | --- |
| WF1 standard school | photosynthesis → 16 stages → completed release record | n/a | [ ] |
| WF2 verifier rejection | one claim rejected then accepted; exhaustion variant | [x] | [ ] |
| WF3 transport recovery | truncation retry; hang fallback; crash-before-checkpoint resume | [x] | [ ] |

## Promotion gate (Phase 6)
- [ ] all step boxes ticked
- [x] gap modules ported to `packages/`
- [x] `packages/*/test` regression suites pass
- [x] governing-doc updates committed in the same change
- [x] harness retained under `test/` as the sandbox

## Smarter intake + web research + medical deprecation

| Area | Regression | Status |
| --- | --- | --- |
| Intake v2 configuration extraction (duration expression, level, aspect ratio, selected-language preservation) | `packages/providers/test/intake-policy.test.ts` | [x] |
| Web-research transport and provenance parsing | `packages/providers/test/websearch.test.ts` | [x] |
| Source-less run → web source rows → valid evidence map | `packages/pipeline/test/research-web.test.ts` | [x] |
| Research-web model route assertion | `packages/pipeline/test/model-route.test.ts` | [x] |
| Medical domain/clinician removal (domain, DB, approvals, capabilities) | `packages/pipeline/test/domain-qa.test.ts`, `approvals-policy.test.ts` | [x] |

## Brave web research (s02, source-less runs — sandbox + promoted)

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| MCP stdio client, string classifier, pinned-schema assertion (`@brave/brave-search-mcp-server@2.1.4`) | `packages/providers/src/brave-mcp.ts` | `test/pipeline/steps/s02-research/brave/test.ts`, `packages/providers/test/brave.test.ts` | [ ] | [x] |
| Five-attempt escalating-timeout ladder, grounding parse | `packages/providers/src/brave.ts` | same | [ ] | [x] |
| Untrusted-input policy + per-URL documents | `packages/pipeline/src/web-research.ts` | `packages/pipeline/test/research-web.test.ts` | n/a | [x] |
| s02 retrieval branch (Brave, no fallback) | `packages/pipeline/src/pipeline/stages/s02-research.ts` | `test/pipeline/steps/s02-research/brave/test.ts` | [ ] | [x] |
| Deterministic double + DB-backed retrieval runner | `steps/s02-research/brave/fake-brave-mcp.ts`, `research-brave.ts` | same | n/a | n/a |
| Source-less run creation (zero-source `createVideoRun`) | `packages/pipeline/src/runs.ts` | same | n/a | [x] |

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

## Fact-verification hardening (s03 — sandbox)

Repair-first, drop-on-exhaustion policy: critical claims are never dropped (critical
exhaustion fails the run terminally); non-critical claims drop with a recorded
omission into `verified-fact-pack/v1` only at exhaustion. Deterministic tests live
in `steps/s03-fact-verification/test.ts`.

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| A1 claim policy: classify + `verified-fact-pack/v1` omissions + bounded policy loop | `packages/pipeline/src/verification.ts` | [x] | n/a | [x] |
| A2 claim-local evidence window (neighbours, cite tags, char budget) | `packages/pipeline/src/context.ts` | [x] | n/a | [x] |
| A3 verifier JSON extraction (fence strip, balanced object, throw-on-garbage) | `packages/providers/src/json-extraction.ts` | [x] | n/a | [x] |
| A4 claim-set replacement planner (delete+insert, no drop orphans) | `packages/pipeline/src/verification.ts` | [x] | n/a | [x] |
| A5 correction contract + ID-drift degradation | `packages/pipeline/src/verification.ts` | [x] | n/a | [x] |

Promoted into `packages/` with regression suites in
`packages/pipeline/test/verification-policy.test.ts`,
`packages/pipeline/test/context-window.test.ts`,
`packages/providers/test/json-extraction.test.ts`, and
`packages/contracts/test/verified-fact-pack.test.ts`, plus the same-change
governing-doc updates in `video-generation-process.md` and `benchmarkstofocus.md`.
The s03 handler now regenerates only rejected claims through the planning route,
replaces `source_claims` in one transaction, and emits `verified-fact-pack/v1`.
The real verifier run still needs `GEMINI_API_KEY`.

## Blueprint hardening (s04 — sandbox)

Deterministic hardening for Flaws 1–6. Pre-generation guards (0 tokens) run over
the verified fact pack and snapshot; QA findings drive a bounded repair loop
instead of failing on the first finding. Tests live in
`steps/s04-blueprint/test.ts` (zero provider keys, zero database); the live
skeleton is `steps/s04-blueprint/live.ts`.

| Item | Where it lives now | Deterministic tests | Live | Promoted |
| --- | --- | --- | --- | --- |
| F1 composite input hash `sha([factPack, snapshotHash])` | `packages/pipeline/src/blueprint-qa.ts` | [x] | n/a | [x] |
| F2 scene-density guard (6–20s/scene) | `packages/pipeline/src/blueprint-qa.ts` | [x] | n/a | [x] |
| F3 critical-claim budget (8/min, pre-gen) + per-scene cap (3) | `packages/pipeline/src/blueprint-qa.ts` | [x] | n/a | [x] |
| F4/F6 visual-beat validation + English directive | `packages/pipeline/src/blueprint-qa.ts`, `prompts/blueprint.ts` | [x] | n/a | [x] |
| F5 bounded blueprint repair loop (max 3, `BLUEPRINT_QA_EXHAUSTED`) | `packages/pipeline/src/blueprint-repair.ts`, `pipeline/stages/s04-blueprint.ts` | [x] | n/a | [x] |

Promoted into `packages/` (Phase 6): the s04 handler runs the 0-token
claim-budget guard before `withFallback`, wraps generation + deterministic QA in
the bounded repair loop, and saves the artifact with the composite input hash.
Regression suites live in `packages/pipeline/test/blueprint-qa.test.ts` and
`packages/pipeline/test/blueprint-repair.test.ts`. The same change updated
`video-generation-process.md` §4, the `benchmarkstofocus.md` Lesson-plan gate row
and evaluation cadence, and `model-recommendations.md`. The real blueprint run
still needs `OPENAI_API_KEY`.

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
