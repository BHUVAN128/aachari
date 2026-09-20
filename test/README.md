# Pipeline Step Harness

A working sandbox for iterating on the educational-video pipeline — prompts,
retry/verification loops, segmentation, pacing, and transport behavior — **without
touching the production build or release path**. It is never part of a production
build and is not shipped. Once every box in [`STATUS.md`](./STATUS.md) is green the
four gap fixes are promoted into `packages/` (Phase 6) and the harness stays here
as the sandbox.

## Purpose
- Run **one pipeline stage at a time** against a real provider route and inspect
  the exact artifact and usage ledger before combining stages.
- Prove the four architecture-D gap fixes (semantic segmentation, bounded
  verifier-rejection loops, transport hardening, visual pacing) against the real
  handlers, then promote them.
- Keep a reproducible end-to-end chain and three conceptual workflows that document
  every input→artifact→handoff boundary.

## Design
- **Real routes, not copies.** Provider, model, fallback, pricing, and credentials
  all come from `packages/providers/src/model-config.ts` (`resolveModelRoute`,
  `STAGE_CAPABILITIES`, `requiredCredentials`). Nothing is duplicated here.
- **Real handlers.** Each `test.ts` calls the production stage handler through a
  `StageContext` built in `setup/context-builder.ts`. Handlers call `getDb()` and
  the provider functions directly, so isolation is done through the environment
  (`setup/stage-context.ts`) rather than by mocking:
  - Postgres: dedicated `upcraft_harness` database, migrated and truncated per run.
  - Object storage: the repo's local MinIO on the `upcraft-harness` bucket.
  - Rendering: `test/pipeline/.render-output/`.
- **Capability preflight is visible.** If a stage's `requiredCredentials()` are
  missing the runner prints `BLOCKED (credential): ...` and records the run as
  blocked. It never fabricates an artifact.
- **Frozen upstream.** Once a step is green its artifact is written to
  `artifacts/<runId>/` and registered in `artifacts/FROZEN.json`; downstream step
  tests hydrate the frozen input instead of re-running (and re-paying for) upstream
  work.
- **Usage ledger modeled on production.** `setup/logger.ts` derives one NDJSON
  record per provider attempt from the harness `provider_usage` table, using the
  same columns the production ledger writes, plus harness-only fields (attempt
  index, verifier outcome, artifact hash, checkpoint outcome).

## Layout
```
test/
├── README.md                 this file
├── STATUS.md                 checkbox tracker per step, gap, workflow
└── pipeline/
    ├── steps/                one folder per step: test.ts, expected-output.json, NOTES.md
    ├── setup/                harness core
    │   ├── stage-context.ts  wires DATABASE_URL / S3 / render dir to harness resources
    │   ├── context-builder.ts builds a real StageContext
    │   ├── runner.ts         runStage() with visible blocked/failed semantics
    │   ├── run-stage.ts      CLI: node test/pipeline/setup/run-stage.ts s02 --input photosynthesis
    │   ├── run-all.ts        chained combine run over green steps
    │   ├── inputs.ts         named mock inputs + run input builder
    │   ├── frozen.ts         freeze/hydrate artifacts between steps
    │   ├── contract.ts       artifact contract validator (schema + invariants)
    │   ├── logger.ts         NDJSON + session.log usage ledger
    │   ── mock-inputs/      photosynthesis, adversarial-segmentation, medical-adjacent
    ├── workflows/            wf1 standard, wf2 verifier rejection, wf3 transport recovery
    ├── artifacts/            frozen green artifacts (FROZEN.json pointer map)
    └── logs/                 <runId>/<step>.ndjson + session.log
```

## How to run
```bash
# one step, one input
node test/pipeline/setup/run-stage.ts s02 --input photosynthesis

# a step test with assertions (blocked steps exit non-zero only on real failure)
node test/pipeline/steps/s02-research/test.ts

# the whole green chain (writes a combined log + cost total)
node test/pipeline/setup/run-all.ts

# type check the harness
npx tsc -p test/pipeline/tsconfig.json
```
`--input` accepts `photosynthesis`, `adversarial-segmentation`, `medical-adjacent`.

## Promotion criteria (Phase 6)
- Every `STATUS.md` step, gap, and workflow box ticked by a real unblocked run.
- Gap modules ported from `test/pipeline/steps/*` into
  `packages/pipeline`, `packages/providers`, `packages/contracts`, `prompts`.
- `packages/*/test` regression suites pass.
- Governing-doc edits for Gap 1 and Gap 2 committed in the same change.
- The harness remains under `test/` as the sandbox.

## Never shipped
`test/` is excluded from the production build and is not a workspace package. It
imports production modules; production modules must never import from `test/`.