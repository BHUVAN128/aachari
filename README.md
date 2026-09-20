# Upcraft educational-video system

Local, source-grounded educational-video generation with PostgreSQL as the durable authority. It uses a real BullMQ/Valkey dispatcher, private MinIO artifacts, actual provider adapters, and a headless Remotion renderer—there is no studio-driven runtime or fake completion path.

## Run locally

1. Copy the provider values you control from [`.env.example`](.env.example) into the ignored `.env.local`. The local database, queue, storage, and render paths are already configured.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3100`.

`npm start` brings up PostgreSQL on `15432`, Valkey on `16379`, MinIO on `19000` (console `19001`), applies the generated Drizzle migration, and starts the web app plus worker.

Model routing lives in [`packages/providers/src/model-config.ts`](packages/providers/src/model-config.ts). Change one registry entry, or set one stage's environment override as a `provider/model` ref, to reroute a stage. The resolved route is frozen onto each stage checkpoint so a release record stays reproducible after an env change.

A submission first creates a frozen input snapshot and database outbox record. If credentials are missing, preflight records a visible terminal failure. Set valid `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID` before expecting an actual voice/render pipeline to proceed. Medical runs additionally require Clerk credentials and a clinician seeded with `npm run db:seed-clinician`.

## Spatial overlays

The pipeline does not accept final overlay coordinates from an LLM. Deterministic SVG diagrams emit measured anchors, which the assets stage persists. A deterministic solver in [`packages/pipeline/src/spatial.ts`](packages/pipeline/src/spatial.ts) (covered by [`packages/pipeline/test/spatial.test.ts`](packages/pipeline/test/spatial.test.ts)) solves an affine placement from subject/target anchors, verifies the resolved attachment, and rejects behind-mask relations with no clip path. Wiring the solver into `runSpatialLayout` and the composition is tracked in [the implementation roadmap](docs/implementation-roadmap.md).

Read [the generation process](docs/video-generation-process.md), [quality gates](docs/benchmarkstofocus.md), and [model routing](docs/model-recommendations.md) before changing the pipeline.
