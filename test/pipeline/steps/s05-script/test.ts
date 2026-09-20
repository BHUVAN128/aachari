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

  console.log("s05 PASS");
};

main().catch((error) => {
  console.error("s05 FAIL:", error);
  process.exit(1);
});