# s05 — Script approval: iteration log

## Scope
Runs the real `runScript` handler: `planning` route (`openai/gpt-5.6-terra`)
writes narration, then the `script-verification` route
(`gemini/gemini-3.8-flash`) independently verifies every line. Emits
`approved-script/v2`.

## Corrections applied
- **Gap 1 (bounded verifier-rejection loop).** `script-verification.ts` specializes
  the s03 loop for script lines: `assertScriptVerificationCompleteWithRejection`
  throws `VerifierRejectionError` carrying exact rejected line ids, and
  `runBoundedScriptVerifierLoop` re-runs only the script generator with the
  correction. Exhaustion is terminal and downstream is never scheduled.
- **Gap 2 (visual pacing).** `pacing.ts` adds a typed `pauseMs` per narration
  line (`PacedApprovedScriptSchema`), derives it from the visual beat dwell need
  (`pauseForVisualAction`), bounds the total pause budget (`validatePacing`), and
  defines the voiceover gate `validatePacedAudio` (measured audio ≥ speech +
  pauses). Promoted at Phase 6 into `packages/contracts` `ScriptLineSchema`,
  `prompts/script.ts`, and `video-generation-process.md` §5/§9.

## Assertions
- script accept-after-correction and exhaustion (Gap 1).
- `pauseMs` present, proportional, bounded; `validatePacing` valid for 120s.
- `validatePacedAudio` rejects audio shorter than speech + pauses (Gap 2).
- `expected-output.json` includes `pauseMs` (target contract; the real handler
  asserts it after Phase 6 promotion).

## Status
- [x] Gap 1 + Gap 2 deterministic tests green
- [ ] real script + verifier run green (needs GEMINI_API_KEY)
