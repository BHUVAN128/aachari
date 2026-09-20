import assert from "node:assert/strict";
import { ClaimVerificationSchema, FactPackSchema } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  VerifierRejectionExhaustedError,
  assertClaimVerificationCompleteWithRejection,
  runBoundedVerifierLoop,
  type CorrectionPrompt,
} from "./verifier-loop.ts";

/**
 * s03 — Fact verification.
 *
 * Gap 1 step test (deterministic, no provider call):
 *   1. accept-after-correction: the verifier rejects claim C-3 once, the loop
 *      re-runs only the generator with the exact rejected ID + rationale, and the
 *      corrected fact pack is accepted on attempt 2.
 *   2. exhaustion: a verifier that always rejects ends in
 *      VERIFIER_REJECTION_EXHAUSTED after MAX_VERIFIER_ATTEMPTS, which is a
 *      terminal visible failure (downstream is never scheduled).
 *   3. every attempt is reported as `rejected-by-verifier` or `completed` so the
 *      ledger can prove the sequence.
 */
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_HASH = "a".repeat(64);
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";

const buildFactPack = (c3Text: string) => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [
    { id: C1, text: "Leaves contain chlorophyll.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-aaaaaaaa"], locator: "p1" }, critical: true },
    { id: C2, text: "Stomata let carbon dioxide enter.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-bbbbbbbb"], locator: "p2" }, critical: true },
    { id: C3, text: c3Text, evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-cccccccc"], locator: "p3" }, critical: true },
  ],
  caveats: [{ text: "Use context." }],
});

/** The verifier rejects C-3 while its text is unrepaired, otherwise accepts. */
const verifyWith = (factPack: ReturnType<typeof FactPackSchema.parse>) => {
  const c3 = factPack.claims.find((claim) => claim.id === C3)!;
  const rejected = !c3.text.includes("corrected");
  const verification = ClaimVerificationSchema.parse({
    schemaVersion: "claim-verification/v2",
    evidence: factPack.claims.map((claim) => ({
      claimId: claim.id,
      sourceId: SOURCE_ID,
      segmentIds: ["segment-aaaaaaaa"],
      supported: claim.id === C3 ? !rejected : true,
      rationale: claim.id === C3 && rejected ? "The cited segment does not state this claim." : "Supported by the cited segment.",
    })),
    notes: [],
  });
  assertClaimVerificationCompleteWithRejection(verification, factPack);
};

const main = async () => {
  // --- accept-after-correction ---
  const attempts: Array<{ attempt: number; outcome: string; rejectedIds: string[] }> = [];
  const corrections: CorrectionPrompt[] = [];

  const accepted = await runBoundedVerifierLoop({
    generate: async (correction) => {
      if (correction) corrections.push(correction);
      return buildFactPack(correction ? "The corrected Calvin cycle fixes carbon dioxide into glucose." : "The Calvin cycle makes glucose.");
    },
    verify: verifyWith,
    onAttempt: (attempt) => {
      attempts.push({ attempt: attempt.attempt, outcome: attempt.outcome, rejectedIds: attempt.rejectedIds });
    },
  });

  assert.deepEqual(attempts.map((entry) => entry.outcome), ["rejected-by-verifier", "completed"]);
  assert.deepEqual(attempts[0]!.rejectedIds, [C3]);
  assert.equal(corrections.length, 1, "the generator must be re-run exactly once with a correction");
  assert.deepEqual(corrections[0]!.rejectedIds, [C3]);
  assert.match(corrections[0]!.rationale, /does not state this claim/);
  assert.ok(accepted.value.claims.find((claim) => claim.id === C3)!.text.includes("corrected"));
  console.log(`  Gap 1: accept-after-correction sequence = ${attempts.map((entry) => entry.outcome).join(" → ")}`);

  // --- exhaustion ---
  const exhaustingAttempts: string[] = [];
  let terminal: unknown = null;
  try {
    await runBoundedVerifierLoop({
      generate: async () => buildFactPack("The Calvin cycle makes glucose."),
      verify: verifyWith,
      onAttempt: (attempt) => {
        exhaustingAttempts.push(attempt.outcome);
      },
    });
  } catch (error) {
    terminal = error;
  }
  assert.ok(terminal instanceof VerifierRejectionExhaustedError, "exhaustion must throw the terminal VerifierRejectionExhaustedError");
  assert.equal((terminal as VerifierRejectionExhaustedError).code, VERIFIER_REJECTION_EXHAUSTED);
  assert.equal(exhaustingAttempts.length, MAX_VERIFIER_ATTEMPTS);
  assert.ok(exhaustingAttempts.every((outcome) => outcome === "rejected-by-verifier"));
  console.log(`  Gap 1: exhaustion sequence = ${exhaustingAttempts.join(" → ")} (terminal ${VERIFIER_REJECTION_EXHAUSTED})`);

  console.log("s03 PASS");
};

main().catch((error) => {
  console.error("s03 FAIL:", error);
  process.exit(1);
});