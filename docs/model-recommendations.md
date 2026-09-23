# Model Recommendations by Job

Model choices are a snapshot as of 2026-09-17. Providers and scores change quickly; use `benchmarkstofocus.md` before replacing a default.

## Change control

This is a governing document under [`AGENTS.md`](../AGENTS.md). Replacing a default model, fallback, or role boundary requires explicit user confirmation through the question tool when available. The approved change must include the candidate benchmark evidence, cost/latency comparison, any workflow impact, and updates to the regression suite.

## Production defaults

| Job | Default | Why | Fallback / escalation |
| --- | --- | --- | --- |
| Intake Briefing Agent (chat configuration extraction) | OpenAI GPT-5.6 Luna via AI Gateway | The user-approved low-cost route is sufficient for strict structured `intake-brief/v3` extraction (topic, learner level, audience, duration, language, aspect ratio, visual style, destination, and a bounded topic-complexity assessment). The agent is toolless and is not a factual, source, narration, or release authority. | Hold intake if the route is unavailable or malformed; do not silently substitute a model without a new policy decision. |
| Source-grounded lesson planning and structured scene manifests | OpenAI GPT-5.6 Terra | It is positioned for intelligence/cost balance, supports tools including web search, and costs $2/$12 per million input/output tokens. Script-generation cost is small relative to media. | GPT-5.6 Sol for difficult, high-stakes review; GPT-5.6 Luna only for low-risk bulk metadata. |
| Independent claim verification | Google Gemini 3.8 Flash | Use a second provider to check citations and unsupported claims; it supports paid search grounding and is priced at $0.75/$3.75 per million input/output tokens through 2026. | GPT-5.6 Terra with a separate verifier prompt when a second provider is unavailable. |
| Web research for source-less runs | Brave Search MCP `brave_llm_context` v2.1.4 over stdio (official `@brave/brave-search-mcp-server`) | Retrieves authoritative LLM-context grounding directly as per-URL snippets, with no separate page fetch and no second model. The server version is pinned and the client asserts the required `count`/`maximum_number_of_tokens`/`context_threshold_mode` parameters at init so a narrowed schema fails loudly instead of silently disabling the threshold ladder. | None. Bounded 5-attempt escalating-timeout retry (10/15/20/35/40 s, jittered backoff, `strict`→`balanced`→`lenient`→`disabled`); auth/quota failures are terminal and never retried; exhaustion is a visible client failure. Gemini search-grounded retrieval remains coded but unused by s02. |
| Core illustrations and consistency edits | Gemini 3.1 Flash Image (Nano Banana 2) | The provider identifies it as the general workhorse for multiple reference images and sequential consistency, which matters more than isolated image beauty. Image models must return PNG; JPEG/AVIF variants are deferred. | Gemini 3 Pro Image for premium art direction; regenerate only the failed scene. |
| Simple high-volume decorative visuals | Gemini 3.1 Flash Lite Image (Nano Banana 2 Lite) | Provider's lowest-cost/fastest option; suitable only when cross-scene reference consistency is not required. PNG output only; never embeds factual labels or text. | Reuse existing generated assets before issuing another request. |
| Diagrams, labels, equations, charts, arrows, and captions | Typed SVG + Remotion components | Generated images can misspell labels or depict incorrect scientific relationships. Deterministic code is cheaper, accessible, and editable. | None; do not delegate factual diagrams to an image model. |
| Long-form teaching narration | ElevenLabs v2 Multilingual | Stable for long-form speech, with one consistent voice and alignment timestamps for caption generation. | ElevenLabs v3 when expressive multi-speaker delivery is required; Flash/Turbo for previews. |
| Private/offline drafting and safety classification | `gpt-oss-20b` / `gpt-oss-safeguard-20b` | Apache 2.0 open weights, controllable deployment, and suitable for drafts, routing, and policy checks. | `gpt-oss-120b` where 80 GB GPU capacity is justified; use hosted models for final high-stakes review. |

## Routing and reliability requirements

- Resolve a concrete provider, model identifier, version when available, capability configuration, and fallback policy before a stage starts. Persist the resolved route on the stage checkpoint; do not rely on a mutable provider default for reproducibility.
- The Intake Briefing Agent is a separate pre-run route, resolved as `openai/gpt-5.6-luna` through AI Gateway. It has no retrieval or media tools and may emit only `intake-brief/v3` (a nullable extraction that code normalizes into a complete brief); its output must be schema-validated before `createVideoRun` is called.
- The M1 content-moderation gate runs before the Intake Briefing Agent on the approved open-weight safety-classification route `openai/gpt-oss-safeguard-20b` through AI Gateway. A deterministic denylist pre-check runs first at zero tokens and may only reject; the model classifier confirms everything else. A safety rejection is terminal and is never retried, and no billable call or run identity is created for a rejected request.
- Persist provider request identifiers, reported token/unit usage, cached and reasoning-token details where available, context-projection version, pricing-version metadata, cost, latency, and outcome for every attempt. Use those records to compare accepted-video cost; never silently trade away evidence or quality to meet a cost target.
- A text-generation route that produces a fact pack, blueprint, script, asset brief, manifest, or QA artifact must support the stage's typed output contract. Validate the returned artifact independently of the provider's structured-output claim.
- The Stage-3 blueprint planning prompt is versioned `lesson_blueprint/v3` and carries the §4 rules (target-language prose, a strictly English visual beat, 6–20s scenes, at most 3 claims per scene). A deterministic QA rejection re-prompts through the bounded `blueprint-repair/v1` prompt, which names the failed rules and the accumulated missing critical-claim ids; the loop is capped at 3 attempts and exhaustion fails the run visibly with `BLUEPRINT_QA_EXHAUSTED`.
- Capability gating is mandatory: do not start work that requires unavailable credentials, search, image, TTS, storage, renderer, approval, or model features. Optional enrichment may be omitted only under the process document's recorded fallback rules.
- A fallback may address a transient provider failure only when it can satisfy the same stage contract and quality gate. It must create a new recorded attempt and undergo the same validation and verification; it must never silently downgrade a critical artifact.
- Source-less web research routes to the official Brave Search MCP server (`brave_llm_context`, pinned to v2.1.4) over stdio. There is no model fallback for this route: retrieval is bounded by a five-attempt escalating-timeout ladder with jittered backoff, HTTP status codes are classified from the server's flattened tool-error string (auth/quota terminal, never retried), and exhaustion surfaces as a visible client failure. The client asserts the tool's required parameters exist at initialization; a narrowed schema is a non-retryable block, never a silent ladder no-op.
- Model routing separates generation from verification where the stage requires independent review. A generator cannot be the sole factual or release authority for its own artifact.
- QA routing is tiered: deterministic Tier A checks use no model, and Tier B is exactly one consolidated verifier call. Do not add per-domain QA reviewers until measured Tier B findings justify them. Tier C human approval is never delegated to a model.
- Image models are approved for PNG illustration only. Do not route factual diagrams, labels, equations, charts, arrows, or captions to an image model, and do not request JPEG or AVIF output.

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
