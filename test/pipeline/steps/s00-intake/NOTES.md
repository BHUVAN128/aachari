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
- Live: real brief normalizes to a complete `intake-brief/v2` within range, with
  recorded projection and domain evidence.

## Status
- [x] 1A–1F deterministic tests green
- [ ] live run green (needs `AI_GATEWAY_API_KEY`)
- [ ] Phase 2 (complexity extraction, safety gate, taxonomy expansion) — awaits
  explicit governing-policy approval
