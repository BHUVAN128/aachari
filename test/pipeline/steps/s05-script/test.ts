import assert from "node:assert/strict";
import { ApprovedScriptSchema, ScriptVerificationSchema } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  VerifierRejectionExhaustedError,
  assertScriptVerificationCompleteWithRejection,
  runBoundedScriptVerifierLoop,
  type CorrectionPrompt,
} from "./script-verification.ts";
import { PacedApprovedScriptSchema, MAX_PAUSE_MS, pauseForVisualAction, sumPauses, validatePacing, validatePacedAudio } from "./pacing.ts";
import {
  SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED,
  ScriptLanguageDirectiveExhaustedError,
  validateEntityDescriptionLanguage,
  validateScriptLanguageDirective,
  validateVisualActionLanguage,
  runBoundedVisualActionLanguageLoop,
} from "./language-directive.ts";

/**
 * s05 — Script approval.
 *
 * Gap 1: a verifier that rejects line L-2 once is corrected with the exact line id
 * and accepted on attempt 2; a verifier that always rejects exhausts visibly.
 *
 * Gap 2: `pauseMs` is a typed field on every narration line; a line whose visual
 * beat needs dwell gets a larger pause; the pause budget is bounded; and the
 * voiceover gate rejects audio shorter than speech + pauses.
 */
const SCENE = "11111111-1111-4111-8111-111111111111";
const L1 = "22222222-2222-4222-8222-222222222222";
const L2 = "33333333-3333-4333-8333-333333333333";

const script = (l2Text: string) => ApprovedScriptSchema.parse({
  schemaVersion: "approved-script/v2",
  narration: [
    { id: L1, sceneId: SCENE, text: "Chlorophyll absorbs light energy.", claimIds: [], visualAction: "Reveal the leaf" },
    { id: L2, sceneId: SCENE, text: l2Text, claimIds: [], visualAction: "Inspect the label" },
  ],
});

const verify = (value: ReturnType<typeof ApprovedScriptSchema.parse>) => {
  const l2 = value.narration.find((line) => line.id === L2)!;
  const rejected = !l2.text.includes("corrected");
  const verification = ScriptVerificationSchema.parse({
    schemaVersion: "script-verification/v2",
    evidence: value.narration.map((line) => ({ lineId: line.id, supported: line.id === L2 ? !rejected : true, unsupportedClaimIds: [], rationale: "Grounded in the locked fact pack." })),
    notes: [],
  });
  assertScriptVerificationCompleteWithRejection(verification, value);
};

const main = async () => {
  // --- Gap 1: accept-after-correction ---
  const attempts: string[] = [];
  const corrections: CorrectionPrompt[] = [];
  const accepted = await runBoundedScriptVerifierLoop({
    generate: async (correction) => {
      if (correction) corrections.push(correction);
      return script(correction ? "The corrected line about the Calvin cycle." : "The Calvin cycle makes glucose.");
    },
    verify,
    onAttempt: (attempt) => {
      attempts.push(attempt.outcome);
    },
  });
  assert.deepEqual(attempts, ["rejected-by-verifier", "completed"]);
  assert.deepEqual(corrections[0]!.rejectedIds, [L2]);
  assert.ok(accepted.value.narration.find((line) => line.id === L2)!.text.includes("corrected"));
  console.log(`  Gap 1 (script): accept-after-correction = ${attempts.join(" → ")}`);

  // --- Gap 1: exhaustion ---
  let terminal: unknown = null;
  const exhausting: string[] = [];
  try {
    await runBoundedScriptVerifierLoop({
      generate: async () => script("The Calvin cycle makes glucose."),
      verify,
      onAttempt: (attempt) => {
        exhausting.push(attempt.outcome);
      },
    });
  } catch (error) {
    terminal = error;
  }
  assert.ok(terminal instanceof VerifierRejectionExhaustedError);
  assert.equal((terminal as VerifierRejectionExhaustedError).code, VERIFIER_REJECTION_EXHAUSTED);
  assert.equal(exhausting.length, MAX_VERIFIER_ATTEMPTS);
  console.log(`  Gap 1 (script): exhaustion = ${exhausting.join(" → ")}`);

  // --- Gap 2: pauseMs typed and proportional ---
  const paced = PacedApprovedScriptSchema.parse({
    schemaVersion: "approved-script/v2",
    narration: [
      { id: L1, sceneId: SCENE, text: "Chlorophyll absorbs light energy.", claimIds: [], visualAction: "Reveal the leaf", pauseMs: pauseForVisualAction("Reveal the leaf") },
      { id: L2, sceneId: SCENE, text: "Trace the oxygen as it leaves the leaf.", claimIds: [], visualAction: "Inspect the label", pauseMs: pauseForVisualAction("Inspect the label") },
    ],
  });
  assert.equal(paced.narration[0]!.pauseMs, 1_000, "reveal beats get 1s");
  assert.equal(paced.narration[1]!.pauseMs, 2_000, "inspect beats get 2s");
  assert.ok(paced.narration.every((line) => line.pauseMs <= MAX_PAUSE_MS));
  assert.equal(sumPauses(paced), 3_000);
  assert.deepEqual(validatePacing({ script: paced, durationSeconds: 120 }), [], "pacing budget must be valid for a 120s lesson");
  console.log(`  Gap 2: pauseMs present; total pauses = ${sumPauses(paced)}ms.`);

  // --- Gap 2: voiceover gate rejects audio shorter than speech + pauses ---
  const underflow = validatePacedAudio({ script: paced, measuredDurationMs: 500, toleranceMs: 0 });
  assert.equal(underflow[0]?.rule, "voice-pacing-underflow");
  const ok = validatePacedAudio({ script: paced, measuredDurationMs: 60_000 });
  assert.deepEqual(ok, []);
  console.log("  Gap 2: paced-audio duration gate works.");

  // --- W3: English visualAction directive ---
  const tamilNarration = "இலை ஒளிச்சேர்க்கையை விளக்குகிறது";
  const localizedAction = tamilNarration;
  const goodScript = {
    schemaVersion: "approved-script/v2",
    narration: [
      { id: L1, sceneId: SCENE, text: tamilNarration, claimIds: [], visualAction: "Reveal the leaf" },
      { id: L2, sceneId: SCENE, text: tamilNarration, claimIds: [], visualAction: "Inspect the label" },
    ],
  };
  assert.deepEqual(validateScriptLanguageDirective(goodScript), [], "Tamil narration with English visualAction must pass");
  assert.ok(pauseForVisualAction(goodScript.narration[0]!.visualAction) > 0 && pauseForVisualAction(goodScript.narration[1]!.visualAction) > 0, "every accepted visualAction must match the pacing vocabulary");
  assert.equal(validateVisualActionLanguage(localizedAction)[0]?.rule, "script-visual-action-localized");
  assert.equal(validateVisualActionLanguage("The leaf is shown")[0]?.rule, "script-visual-action-non-directive");
  console.log("  W3: localized / non-directive visualAction rejected; English beats keep their dwell budget.");

  // --- W3: s06 entity descriptions share the same leak vector ---
  assert.equal(validateEntityDescriptionLanguage({ id: "e1", description: "பச்சையம்" })[0]?.rule, "bible-entity-description-localized");
  assert.deepEqual(validateEntityDescriptionLanguage({ id: "e1", description: "A green chloroplast" }), []);

  // --- W3: bounded repair — English visualAction fixed, narration untouched ---
  const languageAttempts: string[] = [];
  const repaired = await runBoundedVisualActionLanguageLoop({
    generate: async (correction) => {
      if (!correction) return { schemaVersion: "approved-script/v2", narration: [{ id: L1, sceneId: SCENE, text: tamilNarration, claimIds: [], visualAction: localizedAction }] };
      assert.equal(correction.contract.length > 0, true);
      return { schemaVersion: "approved-script/v2", narration: [{ id: L1, sceneId: SCENE, text: tamilNarration, claimIds: [], visualAction: "Reveal the leaf" }] };
    },
    onAttempt: (attempt) => languageAttempts.push(attempt.outcome),
  });
  assert.deepEqual(languageAttempts, ["rejected-by-language-directive", "completed"]);
  assert.equal(repaired.value.narration[0]!.text, tamilNarration, "narration must remain verbatim through a language repair");
  console.log(`  W3: bounded repair = ${languageAttempts.join(" → ")}`);

  // --- W3: a repair that mutates narration is rejected; exhaustion is terminal ---
  let languageTerminal: unknown = null;
  let mutationSeen = false;
  let calls = 0;
  try {
    await runBoundedVisualActionLanguageLoop({
      generate: async () => {
        calls += 1;
        return { schemaVersion: "approved-script/v2", narration: [{ id: L1, sceneId: SCENE, text: calls === 1 ? tamilNarration : "mutated narration", claimIds: [], visualAction: localizedAction }] };
      },
      onAttempt: (attempt) => {
        if (attempt.issues.some((issue) => issue.rule === "script-narration-mutated")) mutationSeen = true;
      },
    });
  } catch (error) {
    languageTerminal = error;
  }
  assert.ok(mutationSeen, "a retry that rewrites narration must be reported as script-narration-mutated");
  assert.ok(languageTerminal instanceof ScriptLanguageDirectiveExhaustedError);
  assert.equal((languageTerminal as ScriptLanguageDirectiveExhaustedError).code, SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED);
  console.log("  W3: narration mutation rejected; exhaustion fails visibly.");

  console.log("s05 PASS");
};

main().catch((error) => {
  console.error("s05 FAIL:", error);
  process.exit(1);
});