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
- Treat medical content as educational only. Medical topics are treated exactly as standard educational topics: there is no medical classification, no special medical source or QA rule, no clinician approval, and no clinician database gate. All research is source-grounded, using the user-supplied source or authoritative sources retrieved from the web.
- Do not use image generation for factual diagrams, labels, equations, charts, or captions when deterministic SVG/Remotion components can represent them.

## Implementation expectations

- Keep the pipeline manifest typed, versioned, and reproducible.
- Preserve source-to-claim links, model/version metadata, asset provenance, QA results, and cost/latency records.
- Respect the dependency rules in the generation-process document; parallelize only work whose declared inputs are locked.
- Add or update regression tests whenever a model, prompt, manifest, rendering behavior, or quality gate changes.
- Keep proprietary source, credentials, generated private assets, and customer data out of public services and version control unless the user explicitly approves it.

## Repository boundaries

`reference/` contains third-party source checkouts for inspection only. It is not part of this product repository, must remain unmodified, and must not be committed as Upcraft Solutions Private Limited IP.

## Development phase and scope boundaries

The repository is currently in a **trial-and-error development phase**. The active
development surface is `test/pipeline/` (the step harness described in
[`test/README.md`](test/README.md) and tracked in [`test/STATUS.md`](test/STATUS.md)).

- Harden, prototype, and iterate on pipeline behavior inside `test/pipeline/`
  first. Sandbox-local schemas, policies, and gap-fix modules live there and are
  proven by deterministic harness tests before any promotion.
- Work inside `test/` is **pre-approved**: create, edit, move, and delete files
  under `test/pipeline/` without asking for confirmation, then run the harness gate
  (`npx tsc -p test/pipeline/tsconfig.json` plus the affected `test.ts`).
- Do **not** modify `apps/`, `packages/`, `infra/`, `scripts/`, or the governing
  documents in `docs/` without asking the user first and receiving explicit
  approval for that exact change. Reading and inspecting them is always allowed.
- Promotion of a proven sandbox module into `packages/` is a separate, explicit
  user-approved change that must carry its regression tests and any governing-doc
  updates in the same change (see the Phase-6 promotion criteria in
  [`test/README.md`](test/README.md)).
- `reference/` remains inspection-only, as stated above.
- `test/` is never part of a production build; production modules must never
  import from `test/`.
