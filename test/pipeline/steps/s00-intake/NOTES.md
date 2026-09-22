# s00 — Intake hardening (pre-run): iteration log

## Scope
Runs the real `generateIntakeBrief` provider call through the real
`intake-brief` gateway route, then applies sandbox-local hardening modules. It is
a pre-run step (intake happens before M1's frozen snapshot), so it does not use
the stage DB/MinIO harness resources and never calls `createVideoRun`.

The modules live in `test/pipeline/setup/intake-hardening/` and are deterministic
and unit-tested; the live gateway call is skipped with a visible `BLOCKED` reason
when `AI_GATEWAY_API_KEY` is absent. Nothing here modifies production code — that
is a Phase-6 promotion.

## Corrections applied (test-local first)
- **1A — broken harness input (bug).** `HARNESS_INPUTS["medical-adjacent"]` still
  declared `domain: "medical"`, a value removed from `DomainSchema`. The harness
  did not typecheck and `createVideoRun` threw on the input. It is now
  `domain: "standard"` (medical topics are standard by policy) and the
  `HarnessInput` domain type is the real `Domain`.
- **1B — code-owned defaults (Point 1).** The production prompt tells the model to
  invent Grade 8 / 60s / 16:9 for omitted fields, making the model the source of
  truth for configuration. `defaults.ts` adds `INTAKE_DEFAULTS` and
  `normalizeIntakeBrief`: a nullable sandbox brief coalesces to a complete
  `intake-brief/v2` and clamps duration into the frozen 15–900s range. The frozen
  `input-snapshot/v1` stays complete, so no downstream stage changes.
  Promotion makes the fields optional in `IntakeBriefV2Schema` and removes the
  defaulting instruction from `packages/providers/src/intake.ts`.
- **1C — bounded intake-context projection (Point 2).** `requestText` may be
  20,000 chars, so pasted source text without the `Source:` delimiter flows into
  M1 unpriced. `projection.ts` bounds the call to 2,000 chars and records the
  projection version, original/projected char counts, truncation flag, and a hash
  — never a silent truncation. Full sources remain M2-only.
- **1D — deterministic domain-validation fallback (Point 5, code half).**
  `domain-routing.ts` validates the agent's classification against a keyword
  heuristic over the approved `standard | engineering | client-production` set.
  It overrides only on a clear signal and records the evidence; with no signal it
  defers to the agent. Medical/health keywords map to `standard` by policy. The
  taxonomy-expansion half of Point 5 is a governing-doc change and is deferred.
- **1E — classified intake retry with backoff (Point 7b).** `retry-policy.ts`
  replaces the hardcoded `attempt < 3` and the zero-spacing re-queue with a
  classified policy: 429/timeout get a longer jittered window, 5xx/network a
  shorter one, auth/quota/validation never retry, bounded by
  `MAX_INTAKE_ATTEMPTS`. Mirrors `packages/pipeline/src/pipeline/retry-policy.ts`.
- **1F — usage/pricing stamping (Point 7a).** `usage.ts` always stamps
  `pricingVersion` and computes cost through the shared `estimateCostMicrounits`
  math; an unpriced gateway route records `costMicrounits: null` **plus**
  `unpriced: true` instead of a bare null.
- **1G — payload hygiene (Point 7c).** Intake never passes `sourceIds`; the
  vestigial `CreateRunInputSchema.sourceIds` field is documented here for removal
  at promotion (`createVideoRun` generates source ids before its transaction).

## Phase 2 (approved policy changes — sandbox prototypes)
All three were explicitly approved. Governing-document updates land with the
Phase-6 promotion, per the "Development phase and scope boundaries" rule in
`AGENTS.md`.
- **2A — topic complexity + derived duration (Point 3).** `complexity.ts` adds
  `SandboxIntakeBriefV3Schema` (`computedComplexity` 1–5, `durationProvided`) and
  `deriveDurationSeconds`: a user-stated duration always wins, otherwise the
  complexity tier (60/90/120/180/300) applies, otherwise the code default. Tiers
  clamp to 15–900s. `extractDurationHint` and `estimateComplexity` are the
  deterministic sandbox stand-ins until the prompt extracts the field. Promotion
  bumps `intake-brief/v2` → `v3` and updates `video-generation-process.md` §2 and
  `benchmarkstofocus.md` routing rows; `s05` pacing needs no change.
- **2B — content moderation gate (Point 6).** `safety.ts` adds the injectable
  `SafetyClassifier`, the deterministic offline `keywordSafetyClassifier` (so no
  harmful content is ever sent by the harness), and the promotion-ready
  `createModelSafetyClassifier` over the approved `gpt-oss-safeguard-20b`
  (`SAFETY_ROUTE`). `moderateRequest` runs **before** any billing or run identity;
  `unsafe`/`review` block with terminal codes (`safety_policy_rejected`,
  `safety_review_required`) that must never be retried. Promotion adds the safety
  capability to `model-config.ts` and the M1 gate to the process doc.
- **2C — domain taxonomy expansion (Point 5).** `domain-taxonomy.ts` widens the
  sandbox enum to `stem`, `humanities`, `legal-compliance`, `business` and extends
  the keyword fallback via the shared generic scorer. Medical/health are **not**
  domains (they map to `standard`). `DOMAIN_TAXONOMY_PROMOTION_PLAN` lists the
  contract + DB-enum + governing-doc changes for promotion.

## 3x — clarification loop (`intake-clarification/v1`)
`setup/intake-hardening/clarification.ts` adds a bounded, stateful clarification
loop in front of the billable briefing call. `intake-runner.ts` wires it into the
s00 state machine.

State machine
- first call: projection → safety gate (terminal, first) → `assessRequestQuality`
  - `clean` → briefing loop (unchanged)
  - `unparseable` → `needs_input`, `attempts: 0`, code-written empathetic question
    (`UNPARSEABLE_QUESTION`), `options: []`
  - `unsure` → injectable model assessor → `ambiguous_request` ask or proceed
  - `roundsUsed >= MAX_CLARIFICATION_ROUNDS` → terminal
    `intake_clarification_exhausted` with no run
- resume (`priorTurns.length > 0`): safety re-runs on the **new** text, heuristics
  and the assessor are skipped entirely, and the briefing call receives the
  resolved Q/A context. This is the fix for the resume double-jeopardy: an answer
  like "Option A" is judged by the brief model, never re-flagged.
- post-brief: `scrubTopicForSnapshot` reuses the structural rules on the extracted
  topic; a garbage topic routes back to one final (capped) clarification round and
  can never freeze.
- `needs_input` carries no run identity; exhaustion is terminal (no retry).

Detector (`assessRequestQuality`)
- RULE 0: `priorTurns.length > 0` ⇒ `clean` (stateful bypass).
- RULE 1: no letter tokens (after stripping zero-width/control characters) ⇒
  `unparseable` (`§±§`, `!!! ###`, `123123`).
- RULE 2: every letter token is structurally suspicious and no whitelist hit ⇒
  `unparseable` (`asdf`, `aaaaaa`, `sdfkjh qwer`). Suspicious = repeated character,
  canonical keyboard mash, consonant-only, or a 4+ consonant run. Single-letter
  tokens are variables; the STEM whitelist (SQL, JWT, C++, x/y/n/π, …) is a
  by-fiat rescue.
- RULE 3: a high symbol ratio is never sufficient alone; with ≤1 letter token it
  defers to the model (`unsure`).
- RULE 4: a dangling function word (`the mitochondria is the`) or ≥half garbled
  tokens (`fotosnthisss werkng plese`) ⇒ `unsure`, never a hard rejection. The
  `unsure` deferral is the "dictionary": ESL/kid/STT input is protected from a
  hard gate, and no wordlist dependency is vendored.

PII stance
- The resume context is transient model input only. It is never written to
  `input-snapshot/v1` (structurally: the snapshot has no `requestText` field), an
  attempt record, or telemetry — only a SHA-256 hash enters the `contextManifest`.
  Raw turns stay in the private per-session `session.log`, which is existing log
  handling.
- The assessor prompt forbids personal details in questions/options; the post-brief
  topic scrub is the deterministic backstop for a topic that would otherwise freeze.

Why the contested calls landed here
- Whitelist, not dictionary: a vendored wordlist is a maintenance/bundle liability
  and still misses proper nouns; `unsure → model` is strictly more capable.
- Options only for `ambiguous_request`: inventing options for raw garbage would be
  hallucination; the honest move is a free-text question.
- Post-brief scrub: closes the "user answers with garbage" hole the resume-context
  fix alone leaves open.

## Assertions
- 1A: `medical-adjacent` → `CreateRunInputSchema` parses with `domain=standard`.
- 1B: null fields → `INTAKE_DEFAULTS`; explicit values preserved; duration
  clamps; defaulted fields reported.
- 1C: short text untruncated; 5,000 chars → 2,000 with recorded metadata;
  invalid `maxChars` throws.
- 1D: five routing cases (engineering override, photosynthesis→standard,
  client-production kept, no-signal defer, health→standard); out-of-enum throws.
- 1E: classification, exponential backoff with injected jitter, budget exhaustion,
  non-retryable failures.
- 1F: pricing version always present; priced route math; unpriced explicitly
  recorded.
- 2A: complexity tiers, explicit-duration precedence, clamps, hint parsing,
  complexity ordering, and the v3 contract.
- 2B: benign vs unsafe classification, medical content stays safe, injected stub
  blocks with a terminal code, review blocks, model runner plumbing validates.
- 2C: expanded-taxonomy routing cases; no medical/health domain; promotion plan.
- 3A: five garbage inputs ⇒ `unparseable` ask, 0 token, `options: []`, no run.
- 3A-STEM: SQL/JWT/C++/E=mc^2/Solve-for-x reach the brief with 0 clarifications.
- 3A-regression: `photosynthesis working` / `photosynthesis` stay clean.
- 3A-safety: safety_policy_rejected precedes clarification.
- 3B: fragment → stub assessor `ambiguous_request` with bounded options + attempt v1.
- 3B-resume: "Option A" is not re-evaluated; brief runs with the resolved context.
- 3B-bound: post-brief guard caps at 2 rounds; the third ask is terminal.
- 3C-STT: garbled real-word input is `unsure`, never hard-rejected.
- 3D-1/2: PII stays transient; snapshot has no `requestText`; NDJSON hashes only.
- 3E: a brief with topic `!!!` is caught and never frozen.
- 3F: assessor attempts are stamped with promptVersion/latency/pricing; malformed
  model output throws.
- Live: real brief normalizes to a complete `intake-brief/v2` within range, with
  recorded projection, safety, complexity, and domain evidence. Real garbage is a
  deterministic `needs_input` ask even before credentials are needed.

## Status
- [x] 1A–1F deterministic tests green
- [x] Phase 2A–2C deterministic tests green
- [x] Promoted to `packages/` with same-change governing-doc updates; the harness remains as the sandbox
- [x] 3x clarification loop deterministic tests green (sandbox-only)
- [ ] 3x promotion to `packages/` (contracts `needs_input`, real assessor route, web option/mic UI) — separate user-approved change
- [ ] live run green (needs `AI_GATEWAY_API_KEY`)
