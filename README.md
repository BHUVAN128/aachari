# Aachari

Local, source-grounded educational-video generation with PostgreSQL as the durable authority. It uses a real BullMQ/Valkey dispatcher, private MinIO artifacts, actual provider adapters, and a headless Remotion renderer—there is no studio-driven runtime or fake completion path.

## Run locally

1. Copy the provider values you control from [`.env.example`](.env.example) into the ignored `.env.local`. The local database, queue, storage, and render paths are already configured.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3100`.

`npm start` brings up PostgreSQL on `15432`, Valkey on `16379`, MinIO on `19000` (console `19001`), applies the generated Drizzle migration, and starts the web app plus worker.

Model routing lives in [`packages/providers/src/model-config.ts`](packages/providers/src/model-config.ts). Change one registry entry, or set one stage's environment override as a `provider/model` ref, to reroute a stage. The resolved route is frozen onto each stage checkpoint so a release record stays reproducible after an env change.

A submission first creates a frozen input snapshot and database outbox record. If credentials are missing, preflight records a visible terminal failure. Set valid `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID` before expecting an actual voice/render pipeline to proceed. A user-supplied source is optional: when none is supplied, the `research-web` route retrieves authoritative pages and persists them as ordinary source documents. Medical topics are treated as standard educational topics with no special approval path.

## Pipeline architecture

The generation process is grouped by governing stage under [`packages/pipeline/src/pipeline/`](packages/pipeline/src/pipeline/):

- `pipeline/stages/` — one module per `video-generation-process.md` stage (`s01-preflight` … `s16-release-record`). Asset production (§7 M6) is split into `s07-assets/{diagrams,illustrations,sound-plan}.ts` so the deferred sound plan and optional illustration logic stay isolated from the required deterministic diagrams.
- `pipeline/registry.ts` — the dependency graph: `stageHandlers` and `stageInputRoles`, read by `getStageInputHash`. The `pipeline-registry` test asserts every stage has a handler and that the governing order cannot be weakened.
- `pipeline/executor.ts` — cross-stage lease claim/heartbeat/checkpoint and retry classification (`processPipelineStage`).
- `pipeline/context.ts` — the explicit `StageContext` service surface every handler receives.
- `prompts/` — provider structured-output JSON schemas; `artifacts/` — the single durable artifact store and hashing; `usage.ts` — provider accounting; `render/` — preview/final master and resolution variants.

The public entry is `@upcraft/pipeline/pipeline` (`processPipelineStage`). [`src/stages.ts`](packages/pipeline/src/stages.ts) is a deprecated compatibility shim that re-exports the new modules.

## Spatial overlays

The pipeline does not accept final overlay coordinates from an LLM. Deterministic SVG diagrams emit measured anchors, which the assets stage persists. A deterministic solver in [`packages/pipeline/src/spatial.ts`](packages/pipeline/src/spatial.ts) (covered by [`packages/pipeline/test/spatial.test.ts`](packages/pipeline/test/spatial.test.ts)) solves an affine placement from subject/target anchors, verifies the resolved attachment, and rejects behind-mask relations with no clip path. It is invoked by [`packages/pipeline/src/pipeline/stages/s10-spatial-layout.ts`](packages/pipeline/src/pipeline/stages/s10-spatial-layout.ts).

Read [the generation process](docs/video-generation-process.md), [quality gates](docs/benchmarkstofocus.md), and [model routing](docs/model-recommendations.md) before changing the pipeline.
