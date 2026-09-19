# OpenMAIC lesson and video generation pipeline

**Investigated revision:** `OpenMAIC` `35a8be59569cae7e3174b82062843b7992c170da` (`fix(pptx): preserve tab columns, text insets, and arrow rendering (#1518)`).

## Executive view

OpenMAIC has two generation architectures. They share the `@openmaic/generation` package, provider adapters, and course/scene vocabulary, but they are not the same request path.

| Entry | User action | Orchestrator | Durable state | Completion channel |
| --- | --- | --- | --- | --- |
| Public/classic API | `POST /api/generate-classroom` (or the legacy-compatible skill/API client) | One background classroom job that generates a whole course | JSON job + classroom files under `data/` | Poll `GET /api/generate-classroom/:jobId` |
| Homepage UI | Enter requirement and press the main generation action | Browser creates a frozen `generationSession`, then the preview performs staged calls | Browser `sessionStorage` + document blobs; final course persistence is deployment-dependent | Generation-preview UI progress |
| Workbench **Send** | Send a natural-language lesson/video request | PostgreSQL-leased Pi agent chooses tools iteratively | PostgreSQL sessions, messages, event log, owner-bound documents/assets | SSE durable event stream; background video also emits `media_ready` |

The literal **Send** button is the Workbench path. A request such as “create a lesson about X” is not mapped to one fixed API call there: the agent receives the request plus only the capabilities configured for that run, then calls tools such as `create_stage`, `generate_scene`, `generate_actions`, `generate_image`, or `generate_video`. This is deliberate: it supports follow-up editing and clarification, unlike the all-at-once public job.

**Evidence:** `components/workbench/WorkbenchChat.tsx:597-665`; `app/api/generate-classroom/route.ts:14-60`; `lib/server/agent-runtime/runner.ts:1429-1468`.

---

## 1. Public whole-classroom generation: step by step

### 1. Submit and validate the job

`POST /api/generate-classroom` accepts JSON shaped as `GenerateClassroomInput`:

```ts
{
  requirement: string;                         // required, non-empty
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}
```

The route whitelists those fields, rejects an empty `requirement` with 400, creates a 10-character job id, writes a queued job record, and returns `202 Accepted` with `{ jobId, status, step, message, pollUrl, pollIntervalMs: 5000 }`. It uses Next.js `after()` to begin slow work only after the response can be returned.

**Evidence:** `app/api/generate-classroom/route.ts:17-60`; `lib/server/classroom-generation.ts:63-101`.

### 2. Job lifecycle, recovery boundary, and polling

The runner deduplicates currently running ids in an in-process `Map`, writes `running`, forwards each progress update to the job store, and finally writes `succeeded` or `failed`. Job records are JSON files in `data/classroom-jobs/<id>.json`; each has status, coarse phase, percentage, timestamps, a deliberately limited input summary, generated-scene counts, final URL/count, and error. Writes use a per-job promise mutex plus atomic rename. A job whose `running` record is untouched for 30 minutes is read as failed/stale.

This is a durable progress record, but not a distributed job queue: the `runningJobs` guard is process-local. A process restart during generation is surfaced as the stale-job failure rather than being silently resumed.

**Evidence:** `lib/server/classroom-job-runner.ts:10-49`; `lib/server/classroom-job-store.ts:15-40,57-94,100-224`.

### 3. Resolve the LLM and optional research context

`generateClassroom` resolves the configured `generate-classroom` model and fails early when its provider requires a missing API key. It binds a narrow `AICallFn` bridge to `callLLM`: system prompt + user prompt in, text out. Individual stages may be independently routed to models (`scene-content:<type>`, `scene-actions`, `agent-profiles`, `web-search-query-rewrite`); unresolved optional routes log a warning and fall back to the classroom model rather than aborting an otherwise valid course.

If web search is on and configured, a short-output (256-token) query-rewrite LLM call turns requirement/PDF text into a search query. Provider search results are formatted into `researchContext`, which is passed only to outline planning. Search failure is explicitly non-fatal and generation continues without it.

**Evidence:** `lib/server/classroom-generation.ts:235-345,427-508`; `lib/server/model-routes.ts`.

### 4. Plan the course before producing pages

The outline call receives `UserRequirements`, extracted PDF text (if supplied), research context, and image/video capability flags. It returns a typed result containing `languageDirective`, `courseTitle`, and ordered `SceneOutline[]`. A failed/invalid outline result ends the job before any course is persisted.

After planning, optional custom agent profiles are generated. Their output is parsed as JSON and checked to contain at least two agents and exactly one `teacher`; any error falls back to the built-in default roster. The outline intentionally happens first because its inferred language directive is an input to roster generation.

**Evidence:** `lib/server/classroom-generation.ts:517-563`; `lib/server/classroom-generation.ts:124-179`; `packages/@openmaic/generation/src/outline-generator.ts`.

### 5. Reserve the course identity before generating assets

The server reserves a generated stage/classroom id *before* media or TTS. Reservation exclusively creates a placeholder JSON document (`reserved: true`, no scenes); readers treat it as absent. This prevents a rare id collision from making a new job write media into another classroom’s asset directory. On success the placeholder is atomically replaced; on a pre-persist failure it is conditionally removed.

**Evidence:** `lib/server/classroom-generation.ts:182-217,565-599`; `lib/server/classroom-storage.ts:188-230,241-268`.

### 6. Generate each page: normalize → content → actions → build

For every outline, the pipeline:

1. Applies `applyOutlineFallbacks` and gates procedural-skill content with the vocational/task-engine feature state.
2. Chooses the content model from scene type: `slide`, `quiz`, `interactive`, or `pbl`.
3. Calls `generateSceneContent`; PBL may fall back from its single-call format to the PBL-v2 agentic planner loop.
4. Retries null/retryable content output with bounded exponential backoff; a failed page is skipped, not fabricated.
5. Calls `generateSceneActions` only after valid content exists, with the agent roster and language directive; it also has bounded retries.
6. Converts the typed content + actions into a `Scene` through the in-memory stage API. A construction failure skips that page. If no pages survive, the whole job fails.

The direct all-course loop is sequential, so a later action prompt can be grounded in prior course structure without concurrently changing the in-memory stage.

**Evidence:** `lib/server/classroom-generation.ts:603-712`; `packages/@openmaic/generation/src/scene-builder.ts:21-114`; `packages/@openmaic/generation/src/generation-retry.ts:177-233`.

### 7. Generate images/video and narration after page structure exists

The classic pipeline performs media after all valid scenes are constructed. Media generation uses outline-declared placeholders, invokes configured image/video provider adapters, stores returned bytes below the reserved classroom’s media location, and replaces matching placeholders in scenes. TTS then synthesizes speech actions and supplies audio references. Media and TTS errors are warnings: valid pedagogical content can still be finalized without optional enrichment.

The file-backed transport has a compatibility exception: it may carry `audioUrl` beside an `audioId` until the client imports the bytes into its asset registry; that URL is not intended to enter persisted client documents.

**Evidence:** `lib/server/classroom-generation.ts:714-761`; `lib/server/classroom-media-generation.ts:1-54`; `lib/media/image-providers.ts`; `lib/media/video-providers.ts`; `lib/audio/tts-providers.ts`.

### 8. Finalize and serve

At 98%, the stage and scene array become `PersistedClassroomData` and are atomically written as `data/classrooms/<id>.json` (or `OPENMAIC_CLASSROOMS_DIR`). The returned classroom URL is `/classroom/<id>`. The job receives `completed`/100% and its poll record stores only the final id, URL, and scene count.

**Evidence:** `lib/server/classroom-generation.ts:751-780`; `lib/server/classroom-storage.ts:10-18,137-185,241-268`.

---

## 2. Homepage UI generation differs from the public job API

The landing page’s generate handler requires a nonblank requirement and an already usable provider. Before navigation it freezes the material list and PDF-extractor configuration, stores each local `File` through `storeDocumentBlob`, builds a `GenerationSessionState` with `UserRequirements`, `SessionDocumentSource[]`, and backward-compatible single-document fields, serializes it to `sessionStorage.generationSession`, then routes to `/generation-preview`.

This protects request integrity at the UI boundary: attachments cannot be added/removed and extractor settings cannot change halfway through creating a session; on a local-storage failure, copied document blobs are removed. It is not the same code path as the public `POST /api/generate-classroom`; the preview coordinates staged generation endpoints.

**Evidence:** `app/page.tsx:569-680`; `app/generation-preview/types.ts:12-145`; `app/api/generate/scene-outlines-stream/route.ts`; `app/api/generate/scene-content/route.ts`; `app/api/generate/scene-actions/route.ts`.

---

## 3. Workbench Send: durable agent generation

### 1. Frontend request and optimistic interaction

The Workbench composer accepts text plus up to its attached durable materials, element references, and `@` course references. Pressing Send immediately changes the UI to STOP to avoid a perceived dead button, but does not invent a server result. Existing sessions call:

```http
POST /api/agent/sessions/:sessionId/messages
Content-Type: application/json

{
  "text": "Create a short lesson and a video…",
  "materialIds": ["…"],        // omitted when empty
  "elementRefs": [{ "…": "…" }], // omitted when empty
  "courseRefs": [{ "…": "…" }]   // omitted when empty
}
```

The first message of a draft conversation creates a session through the ordinary message mechanism, not a separate generation protocol. The API response is only a `202` delivery receipt; the transcript and generated course changes arrive through events.

**Evidence:** `components/workbench/WorkbenchChat.tsx:597-665`; `lib/workbench/session-store.ts:2070-2113`.

### 2. Request validation and durable enqueue

The messages route requires the agent runtime feature and an owner-scoped session. It rejects invalid JSON, non-string material ids, more than 20 or blank material ids, invalid element/course references, a request with neither text nor material, and text beyond `MAX_SESSION_TEXT_LENGTH`. It binds materials to the same owner/session, posts the user message transactionally, schedules a title only for nonempty text, and returns `202` with its sequence/delivery data.

An unknown or differently owned session is deliberately indistinguishable from missing (`404`). This avoids session discovery through the control plane.

**Evidence:** `app/api/agent/sessions/[id]/messages/route.ts:21-123`; `lib/server/agent-runtime/limits.ts`; `lib/server/agent-runtime/session-materials.ts`.

### 3. PostgreSQL is the authority, not the browser connection

`PgAgentSessionStore` is initialized from `DATABASE_URL`. It stores sessions, durable user messages, run/event history, cancellation and leases. Database transactions also register URLs seen in user text and send PostgreSQL notifications only on commit. The runner can run in every app process; it claims work via leases, uses claim generation/event ordering/cancellation from PostgreSQL, and a disconnect never cancels a run.

The client attaches to `GET /api/agent/sessions/:id/events` (SSE). It replays durable events after `Last-Event-ID`, emits a named `caught_up`, then tails notifications with polling as a correctness fallback. Thus a page reload can reconstruct the run instead of relying on transient token streaming.

**Evidence:** `lib/server/agent-runtime/store.ts:1-83`; `lib/server/agent-runtime/runner.ts:1-6,1862-1919`; `app/api/agent/sessions/[id]/events/route.ts:1-120`.

### 4. Agent context and capability-gated tool choice

The runner resolves the agent-driver model, creates an agent with a composed course system prompt, then registers a flat set of tool groups. `ask_user` is always present; other tools are present only when their backing configuration/context is available. This means an LLM cannot legitimately call an unavailable provider tool simply because it appears in generic documentation.

Core generation-related tool calls are:

| Tool | Input/output role | Side effect |
| --- | --- | --- |
| `create_stage`, `patch_stage`, scene/course DSL tools | Create or edit a course document | Owner-authorized document transaction |
| `generate_scene` | `{ stageId, order, title, type, brief, … }` → generated typed page | Upserted page with stable/idempotent scene identity |
| `generate_actions` | `{ stageId, sceneId/order, styleDirective?, synthesizeAudio? }` → known actions | Saves actions; optionally narration assets |
| `duplicate_scene`, `list_scenes` | Copy/query existing course state | Idempotent write or read |
| `generate_image` | `{ stageId, prompt, aspectRatio?, styleHint? }` → asset source/details | Provider call, bounded download, asset persistence; agent patches page separately |
| `generate_video` | `{ stageId, prompt, duration?, aspectRatio?, style? }` → `gen_vid_*` placeholder | Starts detached provider job; later persists and patches matching placeholder |
| `web_search`, material tools, `fetch_url` | Gather bounded context | Read/search with source and untrusted-content controls |
| `ask_user` | Ask a specific blocking question | Ends/waits for the next normal user message |

The exact available set also includes skills, roster, voice-clone, curriculum, scene-preview, and personal-history tools when their capability gates permit them; it is not safe to assume every deployment exposes all of them.

**Evidence:** `lib/server/agent-runtime/runner.ts:1429-1468,1901-1906`; `lib/server/agent-runtime/runner-contract.ts:1-16`; `lib/server/agent-runtime/generation-tools.ts:36-99,670-680`; `lib/server/agent-runtime/generate-image.ts:1-25,190-260`; `lib/server/agent-runtime/generate-video.ts:657-720`.

### 5. Pi harness integration: what is used, why, and where

OpenMAIC uses the **Pi core harness**, pinned to `@earendil-works/pi-agent-core@0.78.0`, plus `@earendil-works/pi-ai@0.78.0` for the message/event protocol. It does **not** use the complete Pi product stack. In particular, OpenMAIC does not use Pi's provider implementations, terminal UI (`pi-tui`), or coding agent; its own Vercel AI SDK connector resolves and calls the actual LLM/provider.

| Pi capability used | OpenMAIC adapter/location | Why OpenMAIC uses it |
| --- | --- | --- |
| `Agent` multi-step loop | `lib/agent/runtime/build-agent.ts`, instantiated by `lib/server/agent-runtime/runner.ts` and native-child execution | Lets one Workbench request alternate model turns and tool calls until it completes, asks a question, errors, or is cancelled. |
| `StreamFn` and Pi assistant event protocol | `lib/agent/runtime/stream-fn.ts` | Bridges OpenMAIC's `streamLLM`/Vercel AI SDK stream into Pi text, thinking, tool-call, completion, and error events. The Pi-side model is metadata only; the adapter resolves OpenMAIC's real `LanguageModel`. |
| `AgentTool` contract and sequential execution | `build-agent.ts`, `lib/server/agent-runtime/*-tools.ts` | Gives all OpenMAIC-defined course, material, search, media, roster, skill, and editing operations one tool-call interface. OpenMAIC forces sequential tool execution and wraps every call with timeout, allowlist, and quota/error hooks. |
| `AgentMessage`/`AgentEvent` transcript and subscriptions | `runner.ts`, `resume.ts`, `tool-call-integrity.ts`, `entry-tree-storage.ts` | Provides a provider-neutral transcript and observable lifecycle. OpenMAIC persists final Pi messages/events in PostgreSQL, repairs interrupted tool calls, and translates live events to its SSE client protocol. |
| Pi `Session` entry-tree storage | `runner.ts:944-951`; `entry-tree-storage.ts`; `personal-history-tools.ts` | Stores/reloads the Pi conversation tree for history and restart/resume logic; this is distinct from OpenMAIC's PostgreSQL lease/session authority. |
| Steering, follow-ups, abort and queue control | `build-agent.ts`; `runner.ts` | Lets an arriving user message steer an active run and lets OpenMAIC stop a run safely. OpenMAIC adds a terminal barrier so a truncated tool-call turn cannot accept unsafe queued work. |
| Context transform/compaction and native skills | `build-agent.ts`; `run-native-child.ts`; `skills.ts` | Supports selected Pi-native child runs, context management, and installed-skill reading/execution when those capabilities are present. |

The boundary is important: **Pi owns the in-process agent loop and tool protocol; OpenMAIC owns almost everything durable and product-specific.** OpenMAIC supplies the system prompt, real LLM routing, tool implementations, ownership checks, document/asset writes, PostgreSQL claims/leases/cancellation, SSE replay, and user-facing status. Pi is therefore a harness embedded inside the Workbench runtime, not the system-of-record or the classroom generator itself.

Pi is used only where OpenMAIC needs an iterative agent: Workbench conversations, their durable runner/resume path, and native-child/skill-related runs. It is not used by the public `/api/generate-classroom` job, homepage preparation, direct `/api/generate/*` staged endpoints, media provider adapters, TTS providers, or the renderer. Those paths call OpenMAIC generation functions and provider connectors directly.

**Evidence:** `package.json:52-53`; `lib/agent/VENDOR.md:1-28`; `lib/agent/runtime/build-agent.ts:1-127`; `lib/agent/runtime/stream-fn.ts:1-48`; `lib/server/agent-runtime/runner.ts:944-951,1429-1530`; `lib/server/agent-runtime/resume.ts`; `lib/server/agent-runtime/entry-tree-storage.ts`; `lib/agent/runtime/run-native-child.ts`.

### 6. Workbench page generation and correction loop

`generate_scene` converts tool parameters to a validated `SceneOutline`, selects a content-stage model via `sceneContentStage(type)`, generates content, normalizes it, builds a complete scene, and persists it through the owner-scoped store. `generate_actions` reads the current scene, constructs continuity context (page ordering, titles and prior speech), creates typed actions, validates them against the supported action vocabulary, and writes the fresh version. Stage mutation fences, abort signals, and checkpoint events prevent stale or duplicate run writes from being treated as success.

Unlike the public loop, the agent can inspect a partially built course, ask the user, use a material/search tool, revise a scene, or generate a different asset before proceeding. That is the “correction” architecture: constrained tools + fresh persisted reads + an iterative agent, rather than a single unobserved mega-prompt.

**Evidence:** `lib/server/agent-runtime/generation-tools.ts:234-607`; `lib/server/agent-runtime/generation-ai-call.ts:7-41`; `lib/server/agent-runtime/mutation-fence.ts`; `lib/server/agent-runtime/ask-user.ts`.

### 7. Workbench video is asynchronous by design

`generate_video` validates a nonempty prompt, chooses an enabled server-side provider/model, and returns immediately with a generated placeholder. A detached job then submits/polls/downloads/persists the provider result, records usage, rereads the latest document, replaces only its own eligible placeholder, and appends a durable `media_ready` event. The background timeout is deliberately independent from the chat cancellation signal because cancelling a chat cannot reliably cancel an already billable provider-side generation request.

Generated video cannot overwrite a user-selected concrete asset accidentally: its replacement rule accepts only the original placeholder, no source, or the current stage’s prior generated media; allocated `ast_` references are preserved. Storage-full, timeout, unavailable-provider, disabled-provider and provider failures are separate tool outcomes rather than a misleading generic success.

**Evidence:** `lib/server/agent-runtime/generate-video.ts:434-654,657-720`; `lib/server/agent-runtime/media-tool-result.ts`; `lib/media/pending-media-allocations.ts`.

---

## 4. Prompt architecture and why stages do not share one prompt

Prompt assets are versioned Markdown templates in `packages/@openmaic/generation/templates/`; formatting/conditional snippets are compiled by the generation package. The common contract is **prompt constrains a small output; code parses, validates, normalizes, and persists it**. Prompts are not the sole correctness mechanism.

| Prompt stage | Grounding and required output | Why it is separate |
| --- | --- | --- |
| Requirements → outlines | Requirement, user profile, extracted PDF summary, available image ids, optional research context; exact top-level JSON `{ languageDirective, courseTitle, outlines }` | This is curriculum planning and language inference. It must choose order/type/assessment cadence, not invent canvas coordinates or spoken timing. |
| Agent profiles | Requirement + already inferred language directive; JSON roster with 2+ agents and exactly one teacher | Identity/persona must be consistent across actions, but belongs after language/course planning. It is not slide content and is independently validated/fallbackable. |
| Slide content | One outline, canvas dimensions, visual/layout and element-schema rules, language/teacher context, optional source-image/media slots; JSON canvas/elements | It must solve geometry, HTML/LaTex/element constraints and concise visual text. Reusing it for a quiz, narration, or outline would force the wrong schema and lose the relevant constraints. |
| Quiz content | One quiz outline/config; typed questions/options/answers | Assessment correctness and answer keys are a different data model; slide positioning rules do not establish question validity. |
| Interactive/PBL content | Widget/PBL-specific configuration and stricter capability rules; PBL can enter its dedicated planner loop | These produce executable interaction/project structures, not a static canvas. A generic slide prompt would neither constrain nor validate them. |
| Actions/narration | Built scene content plus roster, language directive, course position, page titles and prior speech; typed action sequence | Actions coordinate speakers, timing and transitions. Slides explicitly reject lecture-script text; putting narration into the content prompt harms both visual density and continuity. |
| Web-search rewrite | Requirement/PDF context → short search query, capped at 256 output tokens | It is an information-retrieval transformation, not a teaching artifact. Giving it an outline/content prompt would waste budget and risk formatting a course instead of a query. |
| Media prompt | A scene’s declared visual/video intent → provider-specific visual description, aspect/style constraints | It targets a non-text model and must not alter educational structure. Media is optional and late so it cannot block valid lesson completion. |
| PBL evaluation/runtime | Current learner submission, task/milestone state and compact project memory → structured assessment/next-step data | It evaluates evidence after learner interaction; planning prompts lack the actual submission and must not pretend to grade it. |
| Workbench agent system prompt | Current durable conversation, course/element refs, selected skill/material capability blocks and currently registered tools | It is a tool-use policy, not a serialized course schema. It must tell the agent what it can do now and how to use fresh state safely. |

Notable prompt guardrails:

- Outline template insists on language inference rules, a concise course title, scene type limits, quiz placement, known image ids only, and an exact JSON object rather than a bare array.
- Slide template defines bounds, allowed element types and layout semantics; it says slides are visual aids, forbids speaker-style prose and raw LaTex in text elements.
- Action formatting adds same-session continuity (“do not greet again”), page position, and recent prior speech so sequential narration does not drift into repeated introductions.
- Media safety snippets, output-schema templates, and route-specific model selection confine optional visual work instead of letting it mutate lesson facts.

**Evidence:** `packages/@openmaic/generation/templates/requirements-to-outlines/system.md`; `packages/@openmaic/generation/templates/requirements-to-outlines/user.md`; `packages/@openmaic/generation/templates/slide-content/system.md`; `packages/@openmaic/generation/src/prompt-formatters.ts:8-71,141-151`; `packages/@openmaic/generation/templates/*-content/*`; `packages/@openmaic/generation/templates/*-actions/*`.

---

## 5. Quality, hallucination, validation, and safety controls

This system reduces hallucination and malformed-output risk; it does **not** prove factual truth. In particular, web search is optional and a successful structured parse is not independent fact verification. The principal defenses are:

| Risk | Implemented control | Limit |
| --- | --- | --- |
| User input changes during request preparation | Frozen materials/settings snapshot; cleanup on document-blob failure | Applies to homepage preparation, not arbitrary external API clients |
| Missing/invalid configuration | Provider/model capability gates and fail-fast required-key checks | A configured model may still return poor content |
| Weak grounding | Requirement, extracted material text/images, optional cited search context, explicit selected course/element refs | No automatic source-by-source factual adjudication is visible in this pipeline |
| Wrong generation shape | Prompt JSON contracts, TypeScript schemas, action/scene builders, outline fallback normalization | Repairs/normalization can preserve a partial result; they do not make its facts true |
| LLM JSON noise | Exact parse, reasoning-prefix/code-block/object extraction, LaTex/escape/truncation repair, then failure if unusable | Repair is syntactic, not semantic validation |
| Temporary model/provider failure | Retry only retryable failures (408/409/425/429/5xx/network) with capped exponential backoff + jitter; never retry abort/non-retryable 4xx | Persistent model failure still ends/skips the affected work |
| One bad page blocks all learning | Per-scene skip after retries; media/TTS degrade gracefully | A course with zero valid pages fails completely |
| Unsafe rendered model HTML | Storage-boundary HTML/CSS allowlists; script/event/javascript URL removal | This is XSS control, not content-quality scoring |
| Agent overwrites or duplicate writes | Owner scoping, leases, mutation fences, stable scene ids/idempotent duplicate tool, fresh document rereads | Background video intentionally outlives a cancelled chat |
| Untrusted URLs / huge media | SSRF validation, redirect/byte/time budgets, provider enablement and storage quotas | External providers remain trusted dependencies |
| Lost live UI connection | PostgreSQL event log, SSE replay by event id, notification + polling fallback | Requires functional PostgreSQL/runtime configuration |

**Evidence:** `app/page.tsx:582-680`; `packages/@openmaic/generation/src/json-repair.ts:43-65,177-240`; `packages/@openmaic/generation/src/generation-retry.ts:21-24,129-233`; `lib/server/sanitize-scene-content.ts:1-120`; `lib/server/agent-runtime/store.ts:31-64`; `app/api/agent/sessions/[id]/events/route.ts:1-120`; `lib/server/agent-runtime/generate-image.ts:68-147`.

---

## 6. Data flow and storage map

```text
Browser request / file / references
  │
  ├─ Homepage: File -> document blob store + sessionStorage generationSession
  │             -> preview staged endpoints -> Stage/Scene payloads
  │
  ├─ Public API: GenerateClassroomInput JSON
  │             -> data/classroom-jobs/<id>.json
  │             -> LLM text -> parsed outlines/content/actions -> Scene[]
  │             -> data/classrooms/<id>.json + <id>/media + <id>/audio
  │
  └─ Workbench Send: JSON { text, materialIds?, elementRefs?, courseRefs? }
                -> PostgreSQL session/message/event records and owner bindings
                -> leased agent + capability-gated tools
                -> owner-bound course document + allocated assets
                -> SSE event replay / media_ready patch
```

Key in-memory/data types:

- `UserRequirements` is user intent (`requirement`, profile and mode/search options); `SessionDocumentSource` describes an uploaded browser-side file with `id`, metadata, MIME type, order, storage key and extractor provider.
- `GenerateClassroomInput` is the public server contract; `ClassroomGenerationJob` is a progress/result summary, not a copy of all source material.
- `SceneOutline` is the planner’s ordered intent; `Generated*Content` and `Action[]` are typed generated primitives; `Scene` is the persisted per-page representation; `Stage` carries course metadata, roster refs/config and video manifest.
- Workbench `WorkbenchMaterial` is a metadata receipt for a durable material asset. The Send payload carries material ids, never raw `File` bytes. Element/course refs are validated before entering the durable user event.
- Classic classroom output remains file-backed. Workbench sessions/events are PostgreSQL-backed and its documents/assets are owner-bound persistence records; generated media is persisted then referenced from the course document.

**Evidence:** `lib/types/generation.ts`; `app/generation-preview/types.ts`; `lib/server/classroom-generation.ts:63-119`; `lib/server/classroom-job-store.ts:15-40`; `lib/types/stage.ts`; `lib/workbench/session-store.ts:2083-2123`; `lib/server/agent-runtime/store.ts:1-83`.

## Practical conclusion

For a product integration that needs one requested classroom and can poll, use the public job path and consume its final classroom URL. For an interactive user who may refine the lesson, attach materials, request a video, inspect a page, or correct the course, use Workbench Send and listen to its durable SSE stream. Do not treat the public job as an agent session or treat Workbench Send as a synchronous video API: their validation, state ownership, retry behavior, and completion semantics are intentionally different.
