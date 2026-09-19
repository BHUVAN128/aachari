# Model Recommendations by Job

Model choices are a snapshot as of 2026-09-17. Providers and scores change quickly; use `benchmarkstofocus.md` before replacing a default.

## Change control

This is a governing document under [`AGENTS.md`](../AGENTS.md). Replacing a default model, fallback, or role boundary requires explicit user confirmation through the question tool when available. The approved change must include the candidate benchmark evidence, cost/latency comparison, any workflow impact, and updates to the regression suite.

## Production defaults

| Job | Default | Why | Fallback / escalation |
| --- | --- | --- | --- |
| Intake Briefing Agent (chat metadata extraction) | OpenAI GPT-5.6 Luna via AI Gateway | The user-approved low-cost route is sufficient for strict structured metadata and conservative risk classification. The agent is toolless and is not a factual, source, narration, or release authority. | Hold intake if the route is unavailable or malformed; do not silently substitute a model without a new policy decision. |
| Source-grounded lesson planning and structured scene manifests | OpenAI GPT-5.6 Terra | It is positioned for intelligence/cost balance, supports tools including web search, and costs $2/$12 per million input/output tokens. Script-generation cost is small relative to media. | GPT-5.6 Sol for difficult, high-stakes review; GPT-5.6 Luna only for low-risk bulk metadata. |
| Independent claim verification | Google Gemini 3.8 Flash | Use a second provider to check citations and unsupported claims; it supports paid search grounding and is priced at $0.75/$3.75 per million input/output tokens through 2026. | GPT-5.6 Terra with a separate verifier prompt when a second provider is unavailable. |
| Medical educational review | GPT-5.6 Sol plus clinician approval | High-quality model assistance is not a release authority. Medical content must remain source-grounded and clinician-approved. | Hold content; never downgrade to automatic publication. |
| Core illustrations and consistency edits | Gemini 3.1 Flash Image (Nano Banana 2) | The provider identifies it as the general workhorse for multiple reference images and sequential consistency, which matters more than isolated image beauty. | Gemini 3 Pro Image for premium art direction; regenerate only the failed scene. |
| Simple high-volume decorative visuals | Gemini 3.1 Flash Lite Image (Nano Banana 2 Lite) | Provider's lowest-cost/fastest option; suitable only when cross-scene reference consistency is not required. | Reuse existing generated assets before issuing another request. |
| Diagrams, labels, equations, charts, arrows, and captions | Typed SVG + Remotion components | Generated images can misspell labels or depict incorrect scientific relationships. Deterministic code is cheaper, accessible, and editable. | None; do not delegate factual diagrams to an image model. |
| Long-form teaching narration | ElevenLabs v2 Multilingual | Stable for long-form speech, with one consistent voice and alignment timestamps for caption generation. | ElevenLabs v3 when expressive multi-speaker delivery is required; Flash/Turbo for previews. |
| Private/offline drafting and safety classification | `gpt-oss-20b` / `gpt-oss-safeguard-20b` | Apache 2.0 open weights, controllable deployment, and suitable for drafts, routing, and policy checks. | `gpt-oss-120b` where 80 GB GPU capacity is justified; use hosted models for final high-stakes review. |

## Routing and reliability requirements

- Resolve a concrete provider, model identifier, version when available, capability configuration, and fallback policy before a stage starts. Persist the resolved route on the stage checkpoint; do not rely on a mutable provider default for reproducibility.
- The Intake Briefing Agent is a separate pre-run route, resolved as `openai/gpt-5.6-luna` through AI Gateway. It has no retrieval or media tools and may emit only `intake-brief/v1`; its output must be schema-validated before `createVideoRun` is called.
- Persist provider request identifiers, reported token/unit usage, cached and reasoning-token details where available, context-projection version, pricing-version metadata, cost, latency, and outcome for every attempt. Use those records to compare accepted-video cost; never silently trade away evidence or quality to meet a cost target.
- A text-generation route that produces a fact pack, blueprint, script, asset brief, manifest, or QA artifact must support the stage's typed output contract. Validate the returned artifact independently of the provider's structured-output claim.
- Capability gating is mandatory: do not start work that requires unavailable credentials, search, image, TTS, storage, renderer, approval, or model features. Optional enrichment may be omitted only under the process document's recorded fallback rules.
- A fallback may address a transient provider failure only when it can satisfy the same stage contract and quality gate. It must create a new recorded attempt and undergo the same validation and verification; it must never silently downgrade a critical artifact.
- Model routing separates generation from verification where the stage requires independent review. A generator cannot be the sole factual or release authority for its own artifact.

## Why this is not a single-model system

- Text models draft and reason, but retrieval plus a separate verifier makes factual failure visible.
- Image models add illustration; they do not author factual diagrams or final text.
- TTS is selected for pronunciation and alignment, not text reasoning.
- Remotion turns approved data into repeatable motion graphics; it is not an AI video model.

This separation makes the system cheaper: the expensive quality model is called a few times per video, images are generated only for genuinely illustrative scenes, and reusable vector assets avoid repeated image calls.

## Open-weight position

`gpt-oss-20b` is the practical first open-weight trial: its weights are Apache 2.0 and it can run with 16 GB memory. It is useful for private deployments, routing, first-pass scene plans, and safety-policy classification. It should not be the only factual or medical authority. Self-hosting cost includes GPU time, operations, monitoring, and upgrades, so benchmark total cost per accepted video rather than calling it free.

## Source snapshot

- [OpenAI model selection and prices](https://platform.openai.com/docs/models/gpt-4-turbo-and-gpt-4)
- [Gemini API prices](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini image-model selection](https://ai.google.dev/gemini-api/docs/image-generation)
- [ElevenLabs API prices](https://elevenlabs.io/pricing/api)
- [Open-weight gpt-oss details](https://openai.com/index/introducing-gpt-oss/)
