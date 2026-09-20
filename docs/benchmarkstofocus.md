# Benchmarks to Focus On

This is the release-quality scorecard for the educational-video pipeline. A general model leaderboard is only a **candidate-selection signal**; a video may ship only when it passes the task-specific checks below. Update this document whenever `video-generation-process.md` adds, removes, or changes a stage.

## Change control

This is a governing document under [`AGENTS.md`](../AGENTS.md). Before changing a benchmark, release gate, threshold, or domain policy, explain the impact and obtain explicit user confirmation through the question tool when available. In the same approved change, update the generation process, model recommendations, regression suite, and implementation wherever they are affected.

## Candidate model signals

| Capability | External signal | How we use it |
| --- | --- | --- |
| General reasoning, STEM, instruction following | [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/data-api) | Shortlist text models; compare quality, latency, and price. |
| Human preference for explanations | [LMArena](https://lmarena.ai/leaderboard) | Tie-breaker for voice, clarity, and writing quality; never a factuality gate. |
| Health safety and communication | [HealthBench](https://openai.com/index/healthbench/) | Required signal for medical-model candidates, alongside our clinician review set. |
| Image quality and value | [Artificial Analysis Image Arena](https://artificialanalysis.ai/image/leaderboard/text-to-image) | Shortlist visual models; validate continuity on our own storyboards. |
| Voice quality | Internal listening and pronunciation suite | Select TTS by naturalness, pronunciation, timing, and language support; there is no sufficient universal public TTS leaderboard. |

## Release benchmark suite

Maintain a versioned, teacher-reviewed evaluation set split into school science, college STEM, engineering, medical education, and production explainers. Every example includes authoritative sources, expected learning objective, expected claims, visual requirements, and prohibited errors.

| Pipeline stage | What to measure | Initial release gate | Failure action |
| --- | --- | --- | --- |
| Chat intake briefing (deferred, not required now) | Structured fields from short requests, conservative medical routing, selected-language preservation, no invented sources/claims, and valid user-source requirement | Retained regression only; not a release gate while deferred | Hold the session; fix prompt/schema/route or require a source. |
| Intake durability and provenance | Session reservation before any model call, input/brief hashes, attempt records, bounded retries, private upload hashes, and handoff to exactly one video run | 100% of required records present; duplicate delivery creates no second run; no raw private source in telemetry | Block intake release and repair persistence/queue/idempotency. |
| Input routing | Correct audience, domain, risk level, language, and format selection | 100% on the routing regression set | Fix routing policy or require clarification. |
| Run integrity | Immutable input snapshot, capability preflight, versioned artifacts, checkpoint records, stable artifact identities, and complete provenance | 100% of required records present; 0 unclassified terminal states | Block the run; repair orchestration or persistence before retrying. |
| Usage and context accounting | Every provider attempt has request metadata, token/unit usage, projection version, artifact/segment references, pricing version, cost, latency, and outcome; telemetry contains no raw private prompt/source duplication | 100% of provider attempts accounted for; no missing usage outcome | Keep the run auditable; repair provider accounting before accepting cost comparisons. |
| Recovery and retries | Retry only classified transient failures; bounded attempts; idempotent replay from the latest valid checkpoint | 100% on retry, stale-run, duplicate-write, and resume regression cases | Block release; fix retry classification, checkpointing, or idempotency. |
| Research | Every material claim has a direct, authoritative source; sources are current enough for the topic | 100% cited material claims; no unsupported high-stakes claim | Reject the lesson plan and research again. |
| Lesson plan | Clear learning objective, prerequisite handling, age-appropriate language, and one teachable idea per visual beat | Teacher score >= 4/5 average; no critical pedagogy issue | Revise plan before scripting. |
| Script accuracy | Correct facts, calculations, units, terminology, uncertainty, and safety language | 100% on critical claims; >= 95% overall supported claims | Regenerate only the failed scene/script section. |
| Medical safety | Accuracy, appropriate uncertainty, non-diagnostic language, red-flag escalation, and source quality | Clinician approval is mandatory | Never auto-publish; hold for clinician revision. |
| Visual plan | Each narration beat has a useful visual action; persistent objects retain identity; diagrams are semantically correct | 0 misleading diagrams, illegible labels, or continuity breaks | Replace the scene asset/animation plan. |
| Image assets (PNG-only) | Prompt adherence, recurring-character/object consistency, style adherence, and absence of invented scientific text; output must be PNG (JPEG/AVIF rejected) | >= 4/5 reviewer score; 0 factual labels embedded in generated images; 100% PNG MIME and byte/dimension verification | Regenerate, edit, or replace with SVG. |
| Spatial layout | Measured anchors solve to x/y transforms; deterministic assertions hold (containment, unique z-order, drift <= 0.75 px, no caption overlap) | 0 solver-assertion failures; 0 out-of-bounds or caption-overlapping layers | Re-solve the overlay from valid anchors; never let a model place pixels. |
| Release QA — Tier A (deterministic) | Schema/artifact completeness, caption wording reconstruction and layout, spatial solve verification, domain policy, voice-alignment duration, render integrity re-probed from produced bytes | 0 critical findings across all deterministic checks at zero token cost | Fix the earliest failed downstream artifact and rerun dependent checks. |
| Release QA — Tier B (one consolidated review) | Exactly one separately routed verifier sees fact pack + script + blueprint + diagram vocabulary + caption cues + preview metadata and returns typed per-domain findings | 0 missed critical defects found by the human review; exactly 1 QA model call per run; deep per-domain branches stay deferred until findings justify them | Fail the run on any critical finding; regenerate the earliest failed artifact. |
| Release QA — Tier C (human approval) | Correct approval level, including mandatory clinician approval for medical content and human approval for any selected AI illustration | 100% of approved runs have the required approval; 0 automatic medical publication | Hold content; never downgrade to automatic publication. |
| Captions | Exact wording, readable line length, speaker synchronization, contrast, and safe-area placement | 0 overflow/overlap defects; word alignment p95 <= 150 ms | Rebuild caption timings/layout. |
| Voiceover | Pronunciation of domain terms, natural pacing, no clipping, and stable voice identity | >= 4/5 listener score; 100% of curated terms accepted | Add pronunciation notes or regenerate audio. |
| Render | Valid duration, audio/video sync, asset loading, no dropped frames, and correct export profile | 100% automated smoke tests pass | Block render and fix the composition. |
| Release record | Reproducible final output with locked manifest, approval, QA evidence, hashes, source links, provider/model versions, and cost/latency data | 100% required release-record fields present; no unresolved critical QA result | Keep the output non-publishable and rebuild the missing or failed artifact. |
| Viewer outcome | Intro retention, scene drops, rewatches, quiz performance, and teacher feedback | Track by video and audience segment | Turn weak scenes into new regression examples. |

## Domain policy

- School and college lessons may publish automatically only after automated source, script, visual, caption, and render gates pass.
- Engineering lessons must show units, assumptions, and calculation steps; a wrong dimension, scale, or safety instruction is critical.
- Medical lessons are educational, not diagnostic or prescriptive. They require current clinical sources and qualified human approval before release.
- Production-company work additionally requires client style approval and a rights/provenance record for every third-party asset.

## Evaluation cadence

Run the small regression suite on every prompt, model, composition, schema, retry, checkpoint, context-projection, or workflow-contract change. Include chat requests such as “photosynthesis working”, explicit field overrides, conservative medical routing, missing/invalid source, TXT/Markdown/PDF extraction, URL-only input, malformed structured output, transient and permanent provider failures, stale-run recovery, duplicate execution, missing required assets, optional-asset fallback, source-verification failure, stale/missing evidence segments, canonical narration reconstruction, PNG-only illustration gating (JPEG/AVIF rejection), spatial-solve assertions (containment, z-order, drift, caption overlap), Tier A/B convergence, a critical Tier B finding, private-telemetry leakage, and blocked medical publication. Deferred modules (chat briefing agent, sound plan, multi-candidate illustration, AVIF, preview-still vision) carry retained regression only and are not release gates. Run the full set before changing a default model or promoting a new context projection. Store model/version, prompt version, source pack, projection manifest, output, token/unit usage, cost, latency, per-gate result, retry/checkpoint evidence, and reviewer feedback so a later model or prompt change is comparable rather than subjective. Establish the first cost baseline from 20 accepted videos; subsequent comparable runs over 125% of the cohort p75 are alert-and-review events, not automatic publication blockers.
