import assert from "node:assert/strict";
import { ClaimVerificationSchema, FactPackSchema } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  VerifierRejectionExhaustedError,
  assertClaimVerificationCompleteWithRejection,
  runBoundedVerifierLoop,
  type CorrectionPrompt,
} from "../../steps/s03-fact-verification/verifier-loop.ts";

/**
 * WF2 — verifier rejection workflow. Deterministic: exercises the bounded loop
 * with a fake generator/verifier so it needs no provider credential. The same
 * loop is used by the real s03/s05 handlers.
 */
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_HASH = "a".repeat(64);
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";

const factPack = (c3Text: string) => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [
    { id: C1, text: "Leaves contain chlorophyll.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-1"], locator: "p1" }, critical: true },
    { id: C2, text: "Stomata let carbon dioxide enter.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-2"], locator: "p2" }, critical: true },
    { id: C3, text: c3Text, evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-3"], locator: "p3" }, critical: true },
  ],
  caveats: [],
});

const verify = (pack: ReturnType<typeof FactPackSchema.parse>) => {
  const c3 = pack.claims.find((claim) => claim.id === C3)!;
  const rejected = !c3.text.includes("corrected");
  const verification = ClaimVerificationSchema.parse({
    schemaVersion: "claim-verification/v2",
    evidence: pack.claims.map((claim) => ({ claimId: claim.id, sourceId: SOURCE_ID, segmentIds: ["segment-1"], supported: claim.id === C3 ? !rejected : true, rationale: claim.id === C3 && rejected ? "Segment 3 does not state this claim." : "Supported." })),
    notes: [],
  });
  assertClaimVerificationCompleteWithRejection(verification, pack);
};

const run = async () => {
  const ledger: Array<{ attempt: number; outcome: string; rejectedIds: string[] }> = [];
  const corrections: CorrectionPrompt[] = [];
  await runBoundedVerifierLoop({
    generate: async (correction) => {
      if (correction) corrections.push(correction);
      return factPack(correction ? "The corrected C-3 claim." : "The C-3 claim.");
    },
    verify,
    onAttempt: (attempt) => {
      ledger.push({ attempt: attempt.attempt, outcome: attempt.outcome, rejectedIds: attempt.rejectedIds });
    },
  });
  assert.deepEqual(ledger.map((entry) => entry.outcome), ["rejected-by-verifier", "completed"]);
  assert.deepEqual(corrections[0]!.rejectedIds, [C3]);
  assert.match(corrections[0]!.rationale, /does not state this claim/);
  console.log(`WF2 accept-after-correction: ${ledger.map((entry) => `${entry.attempt}=${entry.outcome}`).join(" → ")}`);

  const exhausting: string[] = [];
  let terminal: unknown = null;
  try {
    await runBoundedVerifierLoop({
      generate: async () => factPack("The C-3 claim."),
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
  console.log(`WF2 exhaustion: ${exhausting.join(" → ")} → ${VERIFIER_REJECTION_EXHAUSTED} (no downstream scheduled)`);
  console.log("WF2 PASS");
};

run().catch((error) => {
  console.error("WF2 FAIL:", error);
  process.exit(1);
});