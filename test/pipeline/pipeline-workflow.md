# Pipeline Workflow — model → step → work → benchmark

## Scope and derivation notice

This is a **non-governing derived reference**, not a policy document. It maps the
model routes, harness stages, AI work, and release gates that already exist in
this repository so a step-test author can see, in one place, which model a stage
uses and which gate their test must satisfy.

It is derived from the three governing documents and **must not contradict them**:

- [`docs/model-recommendations.md`](../../docs/model-recommendations.md)
- [`docs/video-generation-process.md`](../../docs/video-generation-process.md)
- [`docs/benchmarkstofocus.md`](../../docs/benchmarkstofocus.md)

If this file and a governing document disagree, the governing document wins.
Changing a route, gate, or policy here is not a valid substitute for the
change-control process in [`AGENTS.md`](../../AGENTS.md).

**Executable source of truth:** [`MODEL_ROUTES` / `STAGE_CAPABILITIES`](../../packages/providers/src/model-config.ts)
in `packages/providers/src/model-config.ts`. Stage identifiers and order come from
`STAGE_ORDER` in `packages/contracts/src/index.ts`. This document is a snapshot
of the 2026-09-23 pricing/routing state (`PRICING_VERSION = "pricing/2026-09-23"`)
and must be re-checked against those files whenever a route or stage changes.

Stage aliases (`s01`–`s16`) are declared in
[`STAGE_COMMAND_ALIASES`](setup/run-stage.ts).

## Model inventory (8 coded routes)

| Capability (coded) | Model | Provider | Env key | Default model ID | Pricing | Fallback / policy |
| --- | --- | --- | --- | --- | --- | --- |
| `intake-brief` | GPT-5.6 Luna | `ai-gateway` | `INTAKE_BRIEF_MODEL` | `openai/gpt-5.6-luna` | — | Toolless pre-run route that extracts `intake-brief/v2`; gateway transport; no override provider. |
| `planning` | GPT-5.6 Terra | `openai` | `OPENAI_PLANNING_MODEL` | `gpt-5.6-terra` | 2 / 12 µ$ per input/output token | Fallback `openai/gpt-5.6-sol`. |
| `fact-verification` | Gemini 3.8 Flash | `gemini` | `GEMINI_VERIFIER_MODEL` | `gemini-3.8-flash` | 0.75 / 3.75 µ$ | Fallback `openai/gpt-5.6-terra`. |
| `script-verification` | Gemini 3.8 Flash | `gemini` | `GEMINI_VERIFIER_MODEL` | `gemini-3.8-flash` | 0.75 / 3.75 µ$ | Fallback `openai/gpt-5.6-terra`. |
| `qa-review` | Gemini 3.8 Flash | `gemini` | `GEMINI_VERIFIER_MODEL` | `gemini-3.8-flash` | 0.75 / 3.75 µ$ | Fallback `openai/gpt-5.6-terra`. |
| `research-web` | Brave LLM Context | `brave` | `RESEARCH_WEB_MODEL` | `llm-context/v1` | Per-query rate via `BRAVE_COST_MICRODOLLARS_PER_QUERY` | Official `@brave/brave-search-mcp-server@2.1.4` over stdio for source-less runs. No fallback; bounded 5-attempt escalating-timeout ladder, string-classified auth/quota terminal, schema asserted at init. |
| `illustration` | Gemini 3.1 Flash Image | `gemini` | `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | — | Policy `outputMime: image/png`. No coded fallback. |
| `narration` | ElevenLabs v2 Multilingual | `elevenlabs` | `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | Character rate via `ELEVENLABS_COST_MICRODOLLARS_PER_1K_CHARS` | One consistent voice + alignment timestamps. |

Two approved non-model routes sit outside `MODEL_ROUTES` because they never call
a model:

- **Typed SVG + Remotion components** — diagrams, labels, equations, charts,
  arrows, and captions. Deterministic, 0 tokens, 0 image cost.
- **Open-weight side path** — `gpt-oss-20b` / `gpt-oss-safeguard-20b` for
  private/offline drafting and safety classification. Apache 2.0; not a factual
  authority and not a coded stage route.

Provider escalation options named in `model-recommendations.md` but not coded as
routes today: Gemini 3 Pro Image (premium art direction), Gemini 3.1 Flash Lite
Image (simple high-volume decorative visuals), and GPT-5.6 Sol (difficult
high-stakes review). Selecting any of these is a routing
decision governed by change control, not an env override default.

## Stage-by-stage map (s01–s16)

`null` in `STAGE_CAPABILITIES` means the stage is deterministic and costs 0
tokens. Gates below are quoted from `benchmarkstofocus.md`; the module IDs (`M1`–`M11`)
are from `video-generation-process.md` §1.

### s01 `preflight` — M1 Intake & routing (capability preflight)

- **Model route:** none (`null`). Deterministic capability/storage preflight.
- **AI work:** none. Reserves run identity, freezes the input snapshot, asserts
  required providers/credentials/storage/render capabilities, emits
  `capability-report/v1`. The Intake Briefing Agent runs before the run and
  extracts the full configuration as `intake-brief/v2`; a user source is optional.
- **Benchmarks / gate:** Run integrity and Intake durability/provenance —
  100% of required records present; 0 unclassified terminal states. Input routing
  — 100% on the routing regression set.

### s02 `research` — M2 Research & fact pack

- **Model route:** `planning` → `openai/gpt-5.6-terra` (`OPENAI_PLANNING_MODEL`).
  Source-less runs first call `research-web` → `brave/llm-context/v1`
  (`RESEARCH_WEB_MODEL`) against the pinned Brave Search MCP server.
- **AI work:** one planning call turns the frozen source snapshot into a
  `fact-pack/v2` with material claim-to-source links. When the run has no source,
  `research-web` calls `brave_llm_context` (five-attempt escalating-timeout ladder,
  no model fallback), applies deterministic HTTPS/length/dedupe checks, and
  persists the returned per-URL snippets as ordinary `source_documents` with full
  provenance. `source-evidence-map/v1` is deterministic (sentence-aware
  segmentation with marked overlap).
- **Benchmarks / gate:** Research — 100% cited material claims; no unsupported
  high-stakes claim. Web source provenance — 100% of web-sourced runs have
  fully-provenanced source rows. Usage/context accounting — 100% of provider
  attempts accounted for.

### s03 `fact-verification` — M2 verification

- **Model route:** `fact-verification` → `gemini/gemini-3.8-flash`
  (`GEMINI_VERIFIER_MODEL`), fallback `openai/gpt-5.6-terra`.
- **AI work:** an independently routed verifier checks every material claim
  against the evidence map and emits `claim-verification/v2`. A rejected claim
  drives a bounded verifier-rejection loop (max 3 attempts); exhaustion is
  terminal and never promotes the artifact.
- **Benchmarks / gate:** Research — 100% cited material claims; no unsupported
  high-stakes claim. Generation ≠ verification: the s02 generator is not the sole
  factual authority.

### s04 `blueprint` — M3 Lesson blueprint

- **Model route:** `planning` → `openai/gpt-5.6-terra`.
- **AI work:** one planning call creates the measurable objective, prerequisites,
  hook, explanation arc, recap, and scene/visual beats as `lesson-blueprint/v2`,
  referencing verified claim ids.
- **Hardening (promoted, Flaws 1–6):** a 0-token pre-generation guard rejects an
  over-budget critical-claim set (8/minute, never pruned) before any planning
  call; deterministic QA then checks scene density (6–20s/scene), per-scene claim
  load (≤3), visual-beat directive quality, and English `visualBeat`; a bounded
  repair loop (max 3) re-prompts with the accumulated missing claim ids and fails
  terminally with `BLUEPRINT_QA_EXHAUSTED`; the saved artifact carries the
  composite `sha([factPack, snapshotHash])` input hash. The sandbox modules remain
  under `test/pipeline/steps/s04-blueprint/`.
- **Benchmarks / gate:** Lesson plan — teacher score ≥ 4/5 average; no critical
  pedagogy issue; 0 scene-density violations (6–20s/scene); critical-claim budget
  respected; 0 vague or localized visual beats.

### s05 `script` — M4 Script approval

- **Model route:** `planning` → `openai/gpt-5.6-terra` writes; `script-verification`
  → `gemini/gemini-3.8-flash` independently verifies. The writer receives a
  deterministic projection of the frozen snapshot (learner level, audience,
  language, duration budget).
- **AI work:** narration lines are written from the fact pack, each attached to a
  scene purpose, on-screen text, visual action, and source claims, then verified
  line by line. Emits `approved-script/v2` (canonical narration text; TTS text is
  derived deterministically downstream). Rejections use the same bounded loop as
  s03; `pauseMs` carries the visual-pacing budget.
- **Benchmarks / gate:** Script accuracy — 100% on critical claims; ≥ 95% overall
  supported claims.

### s06 `visual-bible` — M5 Visual bible

- **Model route:** `planning` → `openai/gpt-5.6-terra`.
- **AI work:** one planning call locks palette, typography, icon rules, camera
  behavior, caption safe area, persistent entities, and prohibited patterns as
  `visual-bible/v1`; it guides consistency and embeds no pixels.
- **Benchmarks / gate:** Visual plan — 0 misleading diagrams, illegible labels,
  or continuity breaks.

### s07 `assets` — M6 Asset production (parallel by scene after the bible locks)

- **Model route:** `illustration` → `gemini/gemini-3.1-flash-image`
  (`GEMINI_IMAGE_MODEL`) for PNG-only scene illustrations. Policy escalation
  options: Gemini 3 Pro Image (premium art direction) and Gemini 3.1 Flash Lite
  Image (simple decorative visuals where cross-scene consistency is not needed).
  **Factual diagrams use the typed SVG/Remotion path with no model.**
- **AI work:** 0 (deterministic SVG) or one image call per selected illustration.
  Deterministic `diagram-model/v1` carries all factual meaning; returned media is
  verified for PNG MIME, dimensions, bytes, content hash, provenance, and
  prompt/style adherence. Emits `selected-assets/v1`; omissions are recorded.
- **Benchmarks / gate:** Image assets (PNG-only) — reviewer score ≥ 4/5; 0
  factual labels embedded in generated images; 100% PNG MIME and byte/dimension
  verification. Visual plan — 0 factual diagrams delegated to an image model.

### s08 `voiceover` — M8 Voiceover

- **Model route:** `narration` → `elevenlabs/eleven_multilingual_v2`
  (`ELEVENLABS_MODEL_ID`); credentials `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`.
- **Locked inputs:** `approved-script/v2` + `verified-fact-pack/v1` (curated
  terms derive from the verified pack and the canonical narration).
- **AI work:** one long-form TTS call over the canonical narration with
  `pauseMs`-derived break tags; measures duration, loudness, and voice identity,
  and derives word/character alignment. Curated terms are narration-priority, and
  alignment integrity plus measured pauses are gated before `voiceover/v1` is
  persisted (bounded re-synthesis, never timestamp healing).
- **Benchmarks / gate:** Voiceover — listener score ≥ 4/5; 100% of curated domain
  terms accepted; timestamps strictly positive and monotonic; reserved pauses
  rendered; replay identity binds the verified pack and voice identity.

### s09 `captions` — M8 caption derivation

- **Model route:** none (`null`). Derived deterministically from the locked word
  alignment; captions are never independently paraphrased or guessed.
- **AI work:** none. Emits `caption-timings/v1`; cues are packed width-, boundary-,
  and pause-aware so a cue never straddles a script line or a reserved pause.
- **Benchmarks / gate:** Captions — 0 overflow/overlap defects; word alignment
  p95 ≤ 150 ms.

### s10 `spatial-layout` — M7 Spatial layout

- **Locked inputs:** `approved-script/v2`, `selected-assets/v1` + measured
  anchors, `caption-timings/v1`, and `visual-bible/v1` (bounded caption safe area).
- **Model route:** none (`null`). The LLM may request a semantic relation but
  never supplies x/y, scale, or pixels.
- **AI work:** none. Computes the true per-scene caption zone (script-class width
  wrapping), measures anchors, runs `solveAttachment`, and asserts with
  `assertAttachment`; emits `resolved-layout/v1` with layers sorted by z-index and
  a per-scene `captionZone`.
- **Benchmarks / gate:** Spatial layout — 0 solver-assertion failures; 0
  out-of-bounds or caption-zone-overlapping layers; drift ≤ 0.75 px; exactly one
  selected diagram per narrated scene.

### s11 `manifest` — M9 Composition manifest

- **Model route:** none (`null`).
- **AI work:** none. Converts locked durations, timings, captions, camera moves,
  asset ids, and transitions into typed `video-manifest/v1`, consuming verified
  manifest references only.
- **Benchmarks / gate:** Render — manifest references resolve and voice alignment
  matches the approved script line by line.

### s12 `preview-render` — M9 preview render

- **Model route:** none (`null`). Remotion renders deterministically.
- **AI work:** none. Renders a preview and probes integrity from the produced
  bytes; emits `preview-render/v1`.
- **Benchmarks / gate:** Render — 100% automated smoke tests pass (dimensions,
  duration, fps, frame count, audio track, codec).

### s13 `qa` — M10 Tiered QA

- **Model route:** Tier A is deterministic (0 tokens); Tier B is **exactly one**
  `qa-review` call → `gemini/gemini-3.8-flash` (`GEMINI_VERIFIER_MODEL`), fallback
  `openai/gpt-5.6-terra`. GPT-5.6 Sol is the policy escalation for difficult
  high-stakes review, not the coded default.
- **AI work:** Tier A re-checks schema/completeness, caption reconstruction,
  spatial solve, domain policy, voice-alignment duration, and render integrity.
  One consolidated verifier sees the locked fact pack, script, blueprint, diagram
  vocabulary, caption cues, and preview metadata, and returns
  `consolidated-review/v1` findings tagged `factual`, `pedagogy`, `visual`,
  `audio`. It cannot rewrite the script or add facts.
- **Benchmarks / gate:** Tier A — 0 critical findings at zero token cost. Tier B —
  0 missed critical defects found by human review; exactly 1 QA model call per
  run. Approval is scheduled only when both tiers converge with no critical
  finding.

### s14 `approval` — M10 Tier C human approval

- **Model route:** none (`null`). Executor-owned; the QA stage advances it.
- **AI work:** none. Automatic standard school/college release after automated
  gates pass; **any selected AI illustration forces human review**.
- **Benchmarks / gate:** Tier C — 100% of approved runs have the required
  approval.

### s15 `final-render` — M11 Final render

- **Model route:** none (`null`).
- **AI work:** none. Renders the MP4 plus optional SRT/transcript and resolution
  variants from the approved manifest; emits `final-render/v1`.
- **Benchmarks / gate:** Render — 100% automated smoke tests pass on the final
  output.

### s16 `release-record` — M11 Release record

- **Model route:** none (`null`).
- **AI work:** none. Assembles the immutable `release-record/v1`: input snapshot,
  source pack and claim links, model/provider versions, asset provenance and
  hashes, attempt history, manifest, both QA tiers, approval, cost/latency, and
  final-output hashes.
- **Benchmarks / gate:** Release record — 100% required fields present; no
  unresolved critical QA result. A failed, stale, blocked, or incomplete run must
  remain visibly non-publishable.

## Candidate-selection signals per step type

A general leaderboard is only a **candidate-selection signal**; shipping depends
on the task-specific gates above.

| Step type | External signal | How it is used |
| --- | --- | --- |
| Text reasoning (s02, s04, s05, s06) | Artificial Analysis Intelligence Index | Shortlist text models; compare quality, latency, and price. |
| Explanation quality (s05) | LMArena | Tie-breaker for voice, clarity, and writing; never a factuality gate. |
| Visuals (s07) | Artificial Analysis Image Arena | Shortlist visual models; validate continuity on our own storyboards. |
| TTS (s08) | Internal listening and pronunciation suite | Select by naturalness, pronunciation, timing, and language support; no sufficient universal public TTS leaderboard. |

## Cross-cutting rules

- **Generation ≠ verification.** s03, s05, and the Tier B review run on a
  separately routed provider; a generator is never the sole factual or release
  authority for its own artifact.
- **PNG-only illustrations.** s07 accepts PNG MIME only; JPEG/AVIF variants are
  deferred. Verify bytes, dimensions, hash, and provenance.
- **Factual visuals never use an image model.** Diagrams, labels, equations,
  charts, arrows, and captions are typed SVG/Remotion components with all factual
  meaning computed deterministically.
- **QA tiering is fixed.** Tier A = zero tokens; Tier B = exactly one
  consolidated verifier call; Tier C = human and never delegated to a
  model. Do not add per-domain QA reviewers until measured findings justify it.
- **Fallback is a new recorded attempt only.** A fallback must satisfy the same
  stage contract and gate, create a new attempt, and undergo the same validation
  and verification; it never silently downgrades a critical artifact.
- **Token discipline.** Deterministic checks run first and cost zero tokens;
  model review is consolidated into the smallest number of calls that can still
  detect real defects.
- **No silent substitution.** Every attempt persists provider/model/version,
  pricing version, usage, cost, latency, and outcome so a release stays
  reproducible.

## Harness quick reference

The step harness lives in [`test/pipeline/`](.) and mirrors the 16 stages in
[`steps/`](steps); shared scaffolding is in [`setup/`](setup) and end-to-end
scenarios are in [`workflows/`](workflows).

Run one stage against a named mock input (assertions live in the step's own
`test.ts`):

```bash
node test/pipeline/setup/run-stage.ts s02 --input photosynthesis
```

Run the full chain, stopping at the first blocked or failed stage:

```bash
node test/pipeline/setup/run-all.ts --input photosynthesis
```

Known mock inputs are declared in [`HARNESS_INPUTS`](setup/inputs.ts):
`photosynthesis`, `adversarial-segmentation`, and `medical-adjacent`. The s14
`approval` stage is executor-owned and advanced by s13, so `run-all.ts` skips it.
A missing credential prints a visible `BLOCKED (credential)` reason instead of
fabricating an artifact, so the sandbox can run without every provider key.

End-to-end workflow scenarios:

- [`workflows/wf1-standard-school`](workflows/wf1-standard-school/WALKTHROUGH.md)
- [`workflows/wf2-verifier-rejection`](workflows/wf2-verifier-rejection/WALKTHROUGH.md)
- [`workflows/wf3-transport-recovery`](workflows/wf3-transport-recovery/WALKTHROUGH.md)

Evidence lands so a gate result is reproducible:

- usage/attempt ledger (one JSON object per line, derived from the real
  `provider_usage` rows): `test/pipeline/logs/<runId>/<stage>.ndjson`
- human-readable tail: `test/pipeline/logs/<runId>/session.log`
- built artifacts: `test/pipeline/artifacts/`
- cumulative cost is summed with the production `estimateCostMicrounits` math so
  harness and release ledgers are comparable.
