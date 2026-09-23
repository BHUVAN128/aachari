import assert from "node:assert/strict";
import type { WordTiming } from "@upcraft/contracts";
import { buildLineStructuredNarration, buildPacedLineStructuredNarration, LINE_BREAK, mapStructuredAlignment, pauseBreakTag, stripPauseTags, validateMeasuredBreaks, validateMonotonicWords, type Alignment } from "./line-synthesis.ts";
import { ALIGNMENT_DEFECT, AlignmentDefectExhaustedError, MAX_ALIGNMENT_ATTEMPTS, runBoundedAlignmentSynthesis, validateAlignmentIntegrity } from "./alignment-gate.ts";
import { buildCuratedTerms, deriveDomainTerms, voiceoverInputHash } from "./curated-terms.ts";

/**
 * s08 — Voiceover.
 *
 * Gap 2: line-structured synthesis inserts a deterministic break between approved
 * lines; the alignment mapper accounts for those break offsets and asserts
 * monotonic timestamps. A dropped break or a backwards timestamp is a visible
 * alignment defect.
 */
const buildAligned = (text: string): Alignment => {
  const characters = [...text];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const char of characters) {
    const perChar = 0.05;
    starts.push(cursor);
    cursor += perChar;
    ends.push(cursor);
    void char;
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
};

const main = async () => {
  const lines = ["Chlorophyll absorbs light energy.", "The Calvin cycle fixes carbon dioxide."];
  const structured = buildLineStructuredNarration(lines);
  assert.equal(structured, `Chlorophyll absorbs light energy.${LINE_BREAK}The Calvin cycle fixes carbon dioxide.`);

  const mapped = mapStructuredAlignment(buildAligned(structured), lines);
  assert.deepEqual(mapped.issues, [], `alignment must be valid: ${JSON.stringify(mapped.issues)}`);
  assert.equal(mapped.breaks.length, lines.length - 1, "each line boundary must be observed as a break");
  assert.deepEqual(mapped.words.map((word) => word.text), ["Chlorophyll", "absorbs", "light", "energy.", "The", "Calvin", "cycle", "fixes", "carbon", "dioxide."]);
  console.log(`  Gap 2: structured alignment → ${mapped.words.length} words, ${mapped.breaks.length} break(s), monotonic.`);

  // A non-monotonic alignment is rejected.
  const bad = buildAligned(structured);
  bad.character_start_times_seconds[0] = 10; // first word now starts after it ends
  const badIssues = validateMonotonicWords(mapStructuredAlignment(bad, lines).words);
  assert.ok(badIssues.some((issue) => issue.rule === "alignment-non-monotonic" || issue.rule === "alignment-word-nonpositive"), "non-monotonic alignment must be reported");
  console.log(`  Gap 2: non-monotonic alignment rejected (${badIssues[0]?.rule}).`);

  // A missing break is rejected.
  const flat = mapStructuredAlignment(buildAligned(lines.join(" ")), lines);
  assert.ok(flat.issues.some((issue) => issue.rule === "alignment-break-count"), "a dropped break must be reported");
  console.log("  Gap 2: dropped break rejected.");

  // --- W2: pre-save alignment integrity gate ---
  const good: WordTiming[] = [
    { text: "Chlorophyll", startMs: 0, endMs: 500 },
    { text: "absorbs", startMs: 500, endMs: 900 },
  ];
  assert.deepEqual(validateAlignmentIntegrity(good), []);
  assert.deepEqual(validateAlignmentIntegrity([]).map((issue) => issue.rule), ["alignment-empty"]);
  // The floor/ceil rounding path: start === end === 1.2s → 1200, 1200.
  const rounded: WordTiming[] = [
    { text: "Chlorophyll", startMs: 0, endMs: 1200 },
    { text: "a", startMs: 1200, endMs: 1200 },
  ];
  assert.ok(validateAlignmentIntegrity(rounded).some((issue) => issue.rule === "alignment-word-nonpositive"), "a zero-length word from rounding must be rejected pre-save");
  console.log("  W2: pre-save gate rejects zero-length/empty alignment.");

  // --- W2: bounded re-synthesis — transient defect heals on a later attempt ---
  const outcomes: string[] = [];
  const healed = await runBoundedAlignmentSynthesis({
    synthesize: async (attempt) => ({ words: attempt === 1 ? rounded : good, value: { attempt } }),
    onAttempt: (attempt) => outcomes.push(`${attempt.attempt}:${attempt.outcome}`),
  });
  assert.deepEqual(outcomes, ["1:alignment-defect", "2:completed"]);
  assert.deepEqual(healed.words, good);
  console.log(`  W2: bounded re-synthesis recovered on attempt ${healed.attempts.length}.`);

  // --- W2: permanent defect exhausts visibly and persists nothing ---
  let terminal: unknown = null;
  let synthesisCalls = 0;
  const failing = async () => {
    synthesisCalls += 1;
    return { words: rounded, value: {} };
  };
  try {
    await runBoundedAlignmentSynthesis({ synthesize: async () => failing() });
  } catch (error) {
    terminal = error;
  }
  assert.ok(terminal instanceof AlignmentDefectExhaustedError);
  assert.equal((terminal as AlignmentDefectExhaustedError).code, ALIGNMENT_DEFECT);
  assert.equal((terminal as AlignmentDefectExhaustedError).attempts.length, MAX_ALIGNMENT_ATTEMPTS);

  // --- W2: replay after failure re-synthesizes instead of replaying a dead hash ---
  const callsBeforeReplay = synthesisCalls;
  try {
    await runBoundedAlignmentSynthesis({ synthesize: async () => failing() });
  } catch {
    /* expected exhaustion */
  }
  assert.ok(synthesisCalls > callsBeforeReplay, "a failed run must re-synthesize, never deadlock on a persisted hash");
  console.log(`  W2: exhaustion is visible; replay re-synthesizes (${synthesisCalls} calls total).`);

  // --- W1: narration terms are never starved by long verified-claim terms ---
  const narrationText = "Mitochondria release energy.";
  const longClaimTerms = Array.from({ length: 45 }, (_, index) => `${"x".repeat(30)}${index}`);
  const curated = buildCuratedTerms({ narrationText, verifiedClaimTexts: longClaimTerms });
  assert.ok(curated.includes("mitochondria"), "the narration term must survive even with 45 longer claim terms");
  assert.ok(curated.length <= 40);
  assert.equal(curated[0], "mitochondria", "narration terms take priority over claim-only terms");
  assert.ok(curated.slice(1).some((term) => term.startsWith("x")), "verified-claim-only terms fill the remaining budget");
  // A token that is neither in the narration nor in the supplied verified claims is absent.
  const withoutClaimText = buildCuratedTerms({ narrationText, verifiedClaimTexts: [] });
  assert.ok(!withoutClaimText.some((term) => term.startsWith("x")), "terms from unverified text never enter the curated set");
  console.log(`  W1: narration term prioritised; ${curated.length} curated terms within limit.`);

  // --- W1: single derivation matches the media-qa tokenizer ---
  assert.deepEqual(deriveDomainTerms(["Photosynthesis uses ATP."]).sort(), ["atp", "photosynthesis"].sort());

  // --- W1: replay identity binds the locked script, verified pack, and voice ---
  const verifiedPack = { claims: [{ id: "c1", text: "Mitochondria release energy." }] };
  const baseVoice = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "voice-a" };
  const script = { schemaVersion: "approved-script/v2", narration: [{ id: "l1", text: narrationText }] };
  const hash = voiceoverInputHash({ script, verifiedFactPack: verifiedPack, voice: baseVoice });
  assert.equal(hash, voiceoverInputHash({ script, verifiedFactPack: verifiedPack, voice: { ...baseVoice } }), "same locked inputs replay the same artifact");
  assert.notEqual(hash, voiceoverInputHash({ script, verifiedFactPack: verifiedPack, voice: { ...baseVoice, voiceId: "voice-b" } }), "a voice change must invalidate cached audio");
  assert.notEqual(hash, voiceoverInputHash({ script, verifiedFactPack: verifiedPack, voice: { ...baseVoice, model: "eleven_turbo_v2" } }), "a voice model change must invalidate cached audio");
  assert.notEqual(hash, voiceoverInputHash({ script, verifiedFactPack: { claims: [{ id: "c1", text: "Mitochondria release stored energy." }] }, voice: baseVoice }), "a verified-pack change must invalidate cached audio");
  console.log("  W1: voiceover hash binds script + verified pack + voice identity.");

  // --- W5: deterministic break tags derived from pauseMs ---
  const pacedLines = [
    { text: "Chlorophyll absorbs light energy.", pauseMs: 2_000 },
    { text: "The Calvin cycle fixes carbon dioxide.", pauseMs: 0 },
  ];
  assert.equal(pauseBreakTag(2_000), '<break time="2.000s"/>');
  assert.equal(pauseBreakTag(0), "");
  const pacedText = buildPacedLineStructuredNarration(pacedLines);
  assert.ok(pacedText.includes('energy.<break time="2.000s"/>'), "the reserved pause becomes an explicit break tag");
  assert.equal(stripPauseTags(pacedText).replace(/\n\n/g, " "), "Chlorophyll absorbs light energy. The Calvin cycle fixes carbon dioxide.");
  console.log("  W5: structured narration carries explicit pause tags.");

  // --- W5: measured-gap gate — a rendered break passes, a dropped break fails ---
  const spokenA = [
    { text: "Chlorophyll", startMs: 0, endMs: 500 },
    { text: "absorbs", startMs: 520, endMs: 900 },
    { text: "light", startMs: 920, endMs: 1200 },
    { text: "energy.", startMs: 1220, endMs: 1600 },
    { text: "The", startMs: 3_500, endMs: 3_700 },
    { text: "Calvin", startMs: 3_720, endMs: 4_100 },
    { text: "cycle", startMs: 4_120, endMs: 4_400 },
    { text: "fixes", startMs: 4_420, endMs: 4_700 },
    { text: "carbon", startMs: 4_720, endMs: 5_100 },
    { text: "dioxide.", startMs: 5_120, endMs: 5_600 },
  ];
  assert.deepEqual(validateMeasuredBreaks({ lines: pacedLines, words: spokenA }), [], "a 1.9s gap satisfies the 2s reserved pause within tolerance");
  const dropped = spokenA.map((word, index) => (index >= 4 ? { ...word, startMs: word.startMs - 1_800, endMs: word.endMs - 1_800 } : word));
  assert.equal(validateMeasuredBreaks({ lines: pacedLines, words: dropped })[0]?.rule, "voice-pause-not-rendered");
  console.log("  W5: measured-gap gate distinguishes a rendered break from a dropped one.");

  // --- W5: dropped break drives a bounded re-synthesis retry ---
  const paceOutcomes: string[] = [];
  const paced = await runBoundedAlignmentSynthesis({
    synthesize: async (attempt) => ({ words: attempt === 1 ? dropped : spokenA, value: { attempt } }),
    gate: (words) => validateMeasuredBreaks({ lines: pacedLines, words }),
    onAttempt: (attempt) => paceOutcomes.push(`${attempt.attempt}:${attempt.outcome}`),
  });
  assert.deepEqual(paceOutcomes, ["1:alignment-defect", "2:completed"]);
  assert.deepEqual(paced.words, spokenA);
  console.log(`  W5: dropped pause recovered by bounded retry (${paceOutcomes.join(" → ")}).`);

  console.log("s08 PASS");
};

main().catch((error) => {
  console.error("s08 FAIL:", error);
  process.exit(1);
});