# Agent Instructions

## Governing documents

The following documents are mandatory design and quality policy for this repository:

1. [`docs/video-generation-process.md`](docs/video-generation-process.md) — required generation workflow and dependency order.
2. [`docs/benchmarkstofocus.md`](docs/benchmarkstofocus.md) — model-evaluation and release-quality gates.
3. [`docs/model-recommendations.md`](docs/model-recommendations.md) — approved model routing and rationale.

Read all three before designing, changing, reviewing, or running the educational-video pipeline. Build all code, prompts, schemas, tests, and operational workflows to conform to them.

## Strict change control

- Do not weaken, bypass, reorder, or contradict a requirement in a governing document.
- If a user request requires changing a governing document, a release gate, a default model, a safety policy, or a sequential/parallel dependency, first explain the conflict and ask the user to confirm the exact policy change using the question tool (`request_user_input`) when it is available. If it is unavailable, ask one concise explicit question in the normal conversation.
- After confirmation, update every affected governing document in the same change as the implementation, including the rationale, benchmark impact, and tests or release gates affected.
- Treat medical content as educational only. Never implement automatic medical publication or remove clinician approval without explicit user confirmation and a documented policy change.
- Do not use image generation for factual diagrams, labels, equations, charts, or captions when deterministic SVG/Remotion components can represent them.

## Implementation expectations

- Keep the pipeline manifest typed, versioned, and reproducible.
- Preserve source-to-claim links, model/version metadata, asset provenance, QA results, and cost/latency records.
- Respect the dependency rules in the generation-process document; parallelize only work whose declared inputs are locked.
- Add or update regression tests whenever a model, prompt, manifest, rendering behavior, or quality gate changes.
- Keep proprietary source, credentials, generated private assets, and customer data out of public services and version control unless the user explicitly approves it.

## Repository boundaries

`reference/` contains third-party source checkouts for inspection only. It is not part of this product repository, must remain unmodified, and must not be committed as Upcraft Solutions Private Limited IP.
