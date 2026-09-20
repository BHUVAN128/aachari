# Implementation Roadmap

This is an execution tracker for the governing workflow. It does not alter a
governing requirement; a box may be checked only when the implementation and
the specified regression evidence are present.

## Current verified state

- [x] Intake durability, frozen run snapshot, source evidence mapping, route
  separation, canonical narration, approval policy, and durable outbox spine.
- [~] Phase 0 — stage ownership/recovery: leases, expiry recovery, stable
  media deduplication, real locked-input checkpoint hashes, URL provenance,
  and bounded invalid-artifact regeneration are implemented. This change adds
  periodic lease renewal plus database-level fencing, source/artifact-hash,
  and duplicate-media replay tests. Remaining: crash/resume and
  invalid-artifact-regeneration integration tests.
- [~] Phase 1 — test harness: unit tests, a PostgreSQL lease integration test,
  deterministic Intake Brief policy fences (selected language and conservative
  medical routing), source-URL HTTPS/content-type policy, provider
  transient-vs-permanent failure classification, stale-evidence rejection,
  approval policy (blocked medical publication), claim/script verification
  completeness and support reducers (source-verification failure), and
  optional-asset fallback decisions now exist. Remaining: PDF extraction,
  missing-required-asset, and DB-backed integration scenarios.
- [x] Phase 2 — deterministic scene plans and asset briefs (`scene-plan/v1`,
  `scene-asset-brief/v1`) derived only from locked blueprint/fact-pack/script,
  typed semantic SVG diagrams for processes, comparisons, equations, charts,
  and labelled systems, plus independent label-vocabulary, geometry-overlap,
  contrast, and overflow validation before a scene asset may advance.
- [~] Phase 7 — feedback and cost baseline: a `viewer_outcomes` table,
  `viewer-outcome/v1` contract, and authenticated outcomes API record retention,
  scene drops, rewatches, quiz results, and teacher/reviewer feedback against
  the immutable run; the accepted-video cost baseline exposes nearest-rank p75
  and the 125%-of-p75 review threshold with tests. Remaining: wiring the spatial
  solver into layout/composition and feeding outcomes back into the regression
  set automatically.
- [x] Phase 5 — domain policy gates: engineering lessons must state units,
  assumptions, and calculation steps; medical lessons must cite at least one
  authoritative clinical source (clinician approval remains the release
  authority); client-production work requires a rights/provenance record for
  every asset and an explicit client style approval before release.
- [~] Phase 3 — optional illustration candidates and sound plan: the visual
  bible's persistent entities drive a deterministic per-scene illustration
  decision (recorded omission or candidate), candidates are generated behind
  capability gating and verified from their bytes (PNG MIME, size, intrinsic
  dimensions), and any selected AI illustration forces human approval instead of
  automatic school/college publication. A `sound-plan/v1` artifact exists but is
  deferred/not a release gate, as is multi-candidate illustration evaluation.
  Remaining: reviewer style/text scoring and solver-based placement.
- [~] Phase 4 — measured media gates: caption wording/line/safe-area/contrast
  validation, audio-duration-vs-alignment checks on the narration MP3, render
  integrity measured from the produced MP4 (dimensions, duration, fps, frame
  count, audio track, codec), pre-render asset-availability fencing, spatial
  solver assertion over the persisted `resolved-layout/v1` (containment, unique
  z-order, caption overlap), and persisted renderer/composition/export-profile
  provenance. Release QA is tiered: Tier A composes every deterministic check
  into one zero-token result, Tier B is a single separately routed consolidated
  model review, and `convergeQaTiers` gates approval on both tiers reporting
  with no critical finding. The visual check re-renders the typed diagram models
  persisted on `selected-assets`, and the audio/render check re-probes the stored
  narration and preview bytes instead of the pre-render request. Remaining:
  loudness and pronunciation checks, multi-format renders, and preview-still
  vision in Tier B. Deep per-domain model QA branches are deferred until Tier B
  findings justify them.

## Remaining implementation order

1. [ ] Complete Phase 0/1 evidence: crash-mid-stage recovery, duplicate media
   replay, invalid-artifact regeneration, checkpoint input-hash equality, and
   all benchmark routing/intake/provider/telemetry regressions.
2. [x] Build scene-plan and asset-brief production plus deterministic semantic
   SVG/Remotion diagrams and their label/geometry/contrast validation.
3. [~] Implement optional illustration candidate workflows and a recorded
   sound-plan/fallback artifact after the visual bible locks. Candidate
   generation/verification, recorded illustration decisions, and the sound
   plan are implemented; reviewer style/text scoring and solver placement
   remain.
4. [x] Implement tiered release QA that converges before approval. `qa-branches.ts`
   provides pure deterministic checks (structural/policy, visual/caption,
   spatial-solve, audio/render-integrity) composed by `deterministicQa` into
   Tier A, a `consolidatedReviewQa` reducer for the single separately routed
   Tier B review, and `convergeQaTiers`; `runQa` starts the Tier B call, runs the
   deterministic checks beside it, re-renders diagram models for an independent
   visual verdict, re-probes stored media bytes, and gates approval on both tiers
   with no critical finding. Deep per-domain model QA branches are deferred until
   measured Tier B findings justify them.
5. [~] Add measured voice/caption/render gates, renderer and export-profile
   provenance, and tested multi-format renders. Caption layout, voice-alignment
   duration, render integrity, provenance, and pre-render asset fencing are
   implemented; loudness/pronunciation and multi-format renders remain.
6. [x] Add engineering, medical-source-quality, and client rights/style gates.
7. [~] Wire the spatial solver into layout/composition, then add feedback
   ingestion and the accepted-video cost-baseline workflow. Feedback ingestion
   and the cost baseline are implemented; solver-based layout remains.

## Completion definition

The platform is only “100% implemented” when every required workflow stage and
release gate in `video-generation-process.md` and `benchmarkstofocus.md` has
an implementation and passing regression coverage. A green typecheck alone is
not completion evidence.
