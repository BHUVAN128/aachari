# s02 — Research & fact pack: iteration log

## Scope
Runs the real `runResearch` handler against the harness database using the
`planning` capability route (`openai/gpt-5.6-terra`). Emits `source-evidence-map/v1`
(deterministic) and `fact-pack/v2` (model).

## Corrections applied
- **Gap 3 (semantic segmentation), test-local first.** The production
  `buildSourceEvidenceMap` cut at a fixed 6000-char target and fell back to the
  nearest whitespace, which sliced a sentence — and any definition in it — in
  half. `segmentation.ts` in this step folder adds a sentence-aware boundary
  search plus marked overlap context (`overlap: true`, ~300 chars lookback).
  Primary segments still join losslessly; overlap segments are citable evidence.
  This will be promoted to `packages/pipeline/src/context.ts` at Phase 6.

## Assertions
- `primaryJoin === source` (lossless primary segmentation).
- Contiguous, monotonic primary offsets.
- A definition straddling the 6000-char boundary remains inside one primary
  segment.
- Overlap segments are marked, bounded, and resolvable as citations.
- Real run: `fact-pack/v2` passes schema + `expected-output.json` contract, and
  every cited segment id resolves in the locked evidence map.

## Blocking behavior
When `OPENAI_API_KEY` is absent the runner prints
`s02 BLOCKED (credential): capability "planning" is unavailable: OPENAI_API_KEY is required`
and exits without a fake artifact. The checkbox only turns green after a real,
unblocked run.

## Status
- [ ] live run green
