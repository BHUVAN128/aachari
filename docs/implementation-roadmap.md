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
  and deterministic Intake Brief policy fences (selected language and
  conservative medical routing) exist. The benchmark regression set is not
  complete.
- [x] Phase 2 — deterministic scene plans and asset briefs (`scene-plan/v1`,
  `scene-asset-brief/v1`) derived only from locked blueprint/fact-pack/script,
  typed semantic SVG diagrams for processes, comparisons, equations, charts,
  and labelled systems, plus independent label-vocabulary, geometry-overlap,
  contrast, and overflow validation before a scene asset may advance.
- [~] Phase 3 — optional illustration candidates and sound plan: the visual
  bible's persistent entities drive a deterministic per-scene illustration
  decision (recorded omission or candidate), candidates are generated in
  parallel behind capability gating and verified from their bytes (MIME, size,
  intrinsic dimensions), a recorded `sound-plan/v1` artifact carries ducking
  parameters and explicit per-scene omission, and any selected AI illustration
  forces human approval instead of automatic school/college publication.
  Remaining: reviewer style/text scoring and solver-based placement.
- [~] Phase 4 — measured media gates: caption wording/line/safe-area/contrast
  validation, audio-duration-vs-alignment checks on the narration MP3, render
  integrity measured from the produced MP4 (dimensions, duration, fps, frame
  count, audio track, codec), pre-render asset-availability fencing, and
  persisted renderer/composition/export-profile provenance. Remaining:
  loudness and pronunciation checks, independent parallel QA branches, and
  multi-format renders.

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
4. [ ] Implement independent factual/pedagogy, visual/caption, audio, and
   render-integrity QA branches that converge before approval.
5. [~] Add measured voice/caption/render gates, renderer and export-profile
   provenance, and tested multi-format renders. Caption layout, voice-alignment
   duration, render integrity, provenance, and pre-render asset fencing are
   implemented; loudness/pronunciation and multi-format renders remain.
6. [ ] Add engineering, medical-source-quality, and client rights/style gates.
7. [ ] Wire the spatial solver into layout/composition, then add feedback
   ingestion and the accepted-video cost-baseline workflow.

## Completion definition

The platform is only “100% implemented” when every required workflow stage and
release gate in `video-generation-process.md` and `benchmarkstofocus.md` has
an implementation and passing regression coverage. A green typecheck alone is
not completion evidence.
