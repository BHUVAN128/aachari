# s08 — Voiceover: iteration log

## Scope
Runs the real `runVoiceover` handler through the `narration` route
(`elevenlabs/eleven_multilingual_v2`). Measures duration, loudness, and
pronunciation from produced bytes; emits `voiceover/v1`.

## Corrections applied
- **Gap 2 (visual pacing / line-structured synthesis).** `line-synthesis.ts` here
  defines `buildLineStructuredNarration` (deterministic break markers between
  approved lines), `mapAlignmentToWords` (corrected for break offsets), and
  `validateMonotonicWords` / `validateBreakCount`. A dropped break or a backwards
  timestamp becomes a visible alignment defect. Promoted at Phase 6 into
  `packages/providers/src/elevenlabs.ts` and `packages/pipeline/src/context.ts`.
  The pacing gate itself (`validatePacedAudio`) lives with s05 and is asserted
  here against measured duration.

## Assertions
- structured alignment maps every word across one break; timestamps monotonic.
- non-monotonic alignment rejected.
- dropped break rejected.

## Status
- [x] Gap 2 deterministic tests green
- [ ] real TTS run green (needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)
