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
  periodic lease renewal and a fencing test. Remaining: crash/resume and
  duplicate-media integration tests.
- [~] Phase 1 — test harness: unit tests, a PostgreSQL lease integration test,
  and deterministic Intake Brief policy fences (selected language and
  conservative medical routing) exist. The benchmark regression set is not
  complete.

## Remaining implementation order

1. [ ] Complete Phase 0/1 evidence: crash-mid-stage recovery, duplicate media
   replay, invalid-artifact regeneration, checkpoint input-hash equality, and
   all benchmark routing/intake/provider/telemetry regressions.
2. [ ] Build scene-plan and asset-brief production plus deterministic semantic
   SVG/Remotion diagrams and their label/geometry/contrast validation.
3. [ ] Implement optional illustration candidate workflows and a recorded
   sound-plan/fallback artifact after the visual bible locks.
4. [ ] Implement independent factual/pedagogy, visual/caption, audio, and
   render-integrity QA branches that converge before approval.
5. [ ] Add measured voice/caption/render gates, renderer and export-profile
   provenance, and tested multi-format renders.
6. [ ] Add engineering, medical-source-quality, and client rights/style gates.
7. [ ] Wire the spatial solver into layout/composition, then add feedback
   ingestion and the accepted-video cost-baseline workflow.

## Completion definition

The platform is only “100% implemented” when every required workflow stage and
release gate in `video-generation-process.md` and `benchmarkstofocus.md` has
an implementation and passing regression coverage. A green typecheck alone is
not completion evidence.
