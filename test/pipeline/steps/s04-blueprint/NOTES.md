# s04 — Lesson blueprint: iteration log

## Scope
Runs the real `runBlueprint` handler through the `planning` route
(`openai/gpt-5.6-terra`, fallback `openai/gpt-5.6-sol`). Consumes the frozen
`verified-fact-pack/v1` and the run snapshot; emits `lesson-blueprint/v2`.

## Corrections applied (Flaws 1–6, sandbox-first)
Test-local modules in this folder until Phase-6 promotion.

- **Flaw 1 — composite input hash (`input-composite.ts`).** The handler saved the
  blueprint with `inputHash: sha(factPack)`, omitting the frozen snapshot that
  shaped generation. Diagnosis: not a live cache-poisoning bug (artifacts are
  run-scoped and the executor checkpoint hash already includes `snapshotHash`), but
  a provenance defect and a future content-addressed-cache mismatch hazard.
  `blueprintInputHash(factPack, snapshotHash) = sha([factPack, snapshotHash])`.
- **Flaw 2 — scene-density guard (`pacing-guard.ts`).** The contract only required
  `scenes.min(1)`, so one scene for 10 minutes or sixty scenes for 1 minute both
  passed. `sceneBoundsFor` and `validateSceneDensity` enforce a 6–20s-per-scene
  corridor with rules `blueprint-scene-density-low` / `blueprint-scene-density-high`.
- **Flaw 3 — critical-claim budget (`claim-budget.ts`).** Critical claims are
  undroppable (s03 policy), so a dense source cannot be fixed by pruning; the guard
  must fire before generation at 0 tokens. `validateClaimBudget` enforces
  `CRITICAL_CLAIMS_PER_MINUTE = 8` (`blueprint-claim-budget-exceeded`, pre-generation;
  never prunes), and `validateClaimsPerScene` caps a scene at
  `MAX_CLAIMS_PER_SCENE = 3` (`blueprint-scene-claim-overcrowded`).
- **Flaws 4 + 6 — visual-beat validation (`visual-directives.ts`).** A visual beat
  must be at least 20 chars / 4 words, contain a canvas-direction keyword, and be
  English. `validateVisualBeat` emits `blueprint-visual-beat-localized` (non-Latin
  script), `blueprint-visual-beat-vague`, or `blueprint-visual-beat-nonDirective`.
  `VISUAL_BEAT_PROMPT_RULES` states that objective/hook/recap/purpose use the target
  language while `visualBeat` is strictly English.
- **Flaw 5 — bounded repair loop (`blueprint-repair.ts`).** No loop existed: the
  first QA finding failed the run terminally with no repair chance. Mirrors the
  promoted s03 `runBoundedVerifierLoop`: `BlueprintQaRejectionError` carries the
  failed issues and exact missing claim ids; `runBoundedBlueprintRepairLoop` is
  capped at `MAX_BLUEPRINT_ATTEMPTS = 3` and throws the typed
  `BlueprintQaExhaustedError` (`BLUEPRINT_QA_EXHAUSTED`). The correction prompt
  accumulates the union of missing claim ids across attempts, so the oscillating
  C04→C02 case is repaired on attempt 3 instead of never converging.

## Corrected diagnoses
- Flaw 1 is prophylactic, not a live bug (see above).
- Flaw 4 is narrower than "language leakage": only safe-area text, the diagram-title
  fallback, compositor fallback text, and `visualBeat` are at risk; diagram labels
  are already English facts. The prompt rule is the primary enforcement; the
  deterministic heuristic only catches non-Latin scripts.
- Flaw 5 is not an oscillatory retry loop; it is the absence of any repair loop.

## Known limitations (accepted, documented)
1. Flaw 1 fix is prophylactic — there is no live bug today.
2. Dense sources at short durations now fail s04 visibly and early with remediation
   guidance — intended gate behavior, never silent degradation.
3. The English-`visualBeat` lexical check cannot detect localization into
   Latin-script languages (es/de); the prompt rule is the primary enforcement there.
4. s05 `visualAction` has the same localization exposure — recommended follow-up,
   explicitly out of scope here.
5. The density constants and the locked `minScenes = floor(d/20)` /
   `maxScenes = ceil(d/6)` rounding must be sanity-checked against s05's `pauseMs`
   budget before the promotion constants are frozen.

## Assertions (`test.ts`, zero provider keys, zero database)
- density: bounds for 30/120/600s; low/high rules fire; in-corridor counts pass.
- budget: 8 critical claims per 60s allowed, 25 rejected pre-generation; a scene
  with 4 claims is overcrowded, 3 passes.
- visual beats: Tamil → localized; "Show video" → vague; descriptive prose →
  non-directive; a directed English beat passes; Greek notation is not localized.
- repair loop: oscillating `rejected-by-qa → rejected-by-qa → completed` with the
  accumulated union on attempt 3; exhaustion at 3 with `BLUEPRINT_QA_EXHAUSTED`.
- composite hash: equals `sha([factPack, snapshotHash])`, changes with either input,
  differs from the old fact-pack-only hash.

## Harness files
- `test.ts` — deterministic suite (this is the gate command).
- `live.ts` — retained live `runStepTest` skeleton with `allowFailure`.
- `expected-output.json` — `lesson-blueprint/v2` contract checks.

## Status
- [x] Flaws 1–6 deterministic tests green
- [x] promoted to `packages/` (Phase 6): guards in `blueprint-qa.ts`, loop in
  `blueprint-repair.ts`, prompt rules in `prompts/blueprint.ts`, wiring in
  `pipeline/stages/s04-blueprint.ts`, regression suites in
  `packages/pipeline/test/blueprint-qa.test.ts` and `blueprint-repair.test.ts`,
  and governing-doc updates in `video-generation-process.md` §4,
  `benchmarkstofocus.md`, and `model-recommendations.md`
- [ ] real blueprint run green (needs `OPENAI_API_KEY`)
