# Upcraft Educational Video System Documentation

These documents are the product's governing design policy. Read them in this order before changing the pipeline:

1. [Video generation process](video-generation-process.md) — the required workflow, dependencies, and reasons for each stage.
2. [Benchmarks to focus on](benchmarkstofocus.md) — the quality scorecard, release gates, and domain policies.
3. [Model recommendations](model-recommendations.md) — approved model routing, fallbacks, and cost rationale.

The repository-level [agent instructions](../AGENTS.md) make these policies mandatory. Any user-requested change that conflicts with them requires explicit confirmation before implementation, followed by synchronized updates to every affected document and test.

Additional implementation note:

- [React-to-MP4 rendering and deterministic spatial compositing](react-code-to-video.md) — reference-repository analysis and a non-governing design for headless rendering, audio/caption alignment, and constraint-based image layering.
- [Source-grounded lesson planning and structured scene manifests](source-grounded-lesson-planning.md) — implementation-backed walkthrough of what the planning job creates and forwards, with a worked photosynthesis example.

All documentation and code in this repository are proprietary to Upcraft Solutions Private Limited. See [LICENSE](../LICENSE), [CONTRIBUTING](../CONTRIBUTING.md), and [AUTHORS](../AUTHORS.md).
