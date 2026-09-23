import { describe, expect, it } from "vitest";
import { ClaimVerificationSchema, FactPackSchema, type ClaimVerification, type FactPack } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  VerifierRejectionExhaustedError,
  assertIdPreservation,
  buildVerifiedFactPack,
  classifyVerification,
  planClaimSetReplacement,
  runClaimVerificationPolicyLoop,
  type CorrectionPrompt,
} from "../src/verification.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const sourceHash = "a".repeat(64);
const c1 = "33333333-3333-4333-8333-333333333333";
const c2 = "44444444-4444-4444-8444-444444444444";
const c3 = "55555555-5555-4555-8555-555555555555";
const runId = "99999999-9999-4999-8999-999999999999";
const verifierModel = "gemini/gemini-3.8-flash";
const claimId = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const packWith = (claims: Array<{ id: string; text: string; critical: boolean; segmentId: string }>): FactPack => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: claims.map((claim) => ({ id: claim.id, text: claim.text, evidence: { sourceId, sourceHash, segmentIds: [claim.segmentId], locator: "p" }, critical: claim.critical })),
  caveats: [{ text: "Use context." }],
});

const verificationWith = (pack: FactPack, unsupported: Set<string>, rationale = "The cited segment does not state this claim."): ClaimVerification => ClaimVerificationSchema.parse({
  schemaVersion: "claim-verification/v2",
  evidence: pack.claims.map((claim) => ({ claimId: claim.id, sourceId: claim.evidence.sourceId, segmentIds: claim.evidence.segmentIds, supported: !unsupported.has(claim.id), rationale: unsupported.has(claim.id) ? rationale : "Supported by the cited segment." })),
  notes: [],
});

describe("claim verification policy", () => {
  it("routes critical and non-critical rejections into the repair channel and only non-critical into drop candidates", () => {
    const pack = packWith([
      { id: c1, text: "Supported critical claim.", critical: true, segmentId: "segment-aaaaaaaa" },
      { id: c2, text: "Rejected critical claim.", critical: true, segmentId: "segment-bbbbbbbb" },
      { id: c3, text: "Rejected non-critical claim.", critical: false, segmentId: "segment-cccccccc" },
    ]);
    const classification = classifyVerification(verificationWith(pack, new Set([c2, c3])), pack);
    expect(classification.verifiedClaims.map((claim) => claim.id)).toEqual([c1]);
    expect(classification.repairClaimIds).toEqual([c2, c3]);
    expect(classification.criticalRejections).toEqual([c2]);
    expect(classification.dropCandidates).toEqual([c3]);
  });

  it("costs exactly two generator runs for a 24/25 mixed pack", async () => {
    const total = 25;
    const baseClaims = Array.from({ length: total }, (_, index) => ({ id: claimId(index + 1), text: `Claim number ${index + 1}`, critical: false, segmentId: `segment-${String(index + 1).padStart(8, "0")}` }));
    const rejectedId = claimId(13);
    let generatorCalls = 0;
    const corrections: CorrectionPrompt[] = [];
    const result = await runClaimVerificationPolicyLoop({
      factPack: packWith(baseClaims),
      generate: async (correction) => {
        generatorCalls += 1;
        if (correction) corrections.push(correction);
        return packWith(baseClaims.map((claim) => (claim.id === rejectedId && correction ? { ...claim, text: `${claim.text} repaired` } : claim)));
      },
      verify: (pack) => {
        const target = pack.claims.find((claim) => claim.id === rejectedId)!;
        return verificationWith(pack, target.text.includes("repaired") ? new Set() : new Set([rejectedId]));
      },
      verifierModel,
    });
    expect(generatorCalls).toBe(2);
    expect(result.verifiedFactPack.claims).toHaveLength(total);
    expect(result.verifiedFactPack.omissions).toHaveLength(0);
    expect(corrections[0]?.rejectedIds).toEqual([rejectedId]);
    expect(corrections[0]?.contract).toMatch(/preserve accepted claim ids verbatim/);
  });

  it("drops an unsupported non-critical claim at exhaustion with a recorded omission", async () => {
    const pack = packWith([
      { id: c1, text: "Supported critical claim.", critical: true, segmentId: "segment-aaaaaaaa" },
      { id: c3, text: "Unsupported non-critical claim.", critical: false, segmentId: "segment-cccccccc" },
    ]);
    const result = await runClaimVerificationPolicyLoop({
      factPack: pack,
      generate: async () => pack,
      verify: (candidate) => verificationWith(candidate, new Set([c3])),
      verifierModel,
    });
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["rejected-by-verifier", "rejected-by-verifier", "exhausted-non-critical-drop"]);
    expect(result.droppedClaimIds).toEqual([c3]);
    expect(result.verifiedFactPack.claims.map((claim) => claim.id)).toEqual([c1]);
    expect(result.verifiedFactPack.omissions[0]).toMatchObject({ claimId: c3, attempts: MAX_VERIFIER_ATTEMPTS });
  });

  it("fails terminally when a critical claim survives exhaustion", async () => {
    const pack = packWith([{ id: c2, text: "Unsupported critical claim.", critical: true, segmentId: "segment-bbbbbbbb" }]);
    await expect(runClaimVerificationPolicyLoop({
      factPack: pack,
      generate: async () => pack,
      verify: (candidate) => verificationWith(candidate, new Set([c2])),
      verifierModel,
    })).rejects.toMatchObject({ name: "VerifierRejectionExhaustedError", code: VERIFIER_REJECTION_EXHAUSTED });
  });

  it("buildVerifiedFactPack throws rather than dropping a critical rejection", () => {
    const pack = packWith([{ id: c2, text: "Critical.", critical: true, segmentId: "segment-bbbbbbbb" }]);
    expect(() => buildVerifiedFactPack(pack, verificationWith(pack, new Set([c2])), { attempts: 3 })).toThrow(VerifierRejectionExhaustedError);
  });

  it("records ID drift as a full re-verification instead of failing", () => {
    const verified = packWith([
      { id: c1, text: "One.", critical: true, segmentId: "segment-aaaaaaaa" },
      { id: c2, text: "Two.", critical: true, segmentId: "segment-bbbbbbbb" },
    ]);
    expect(assertIdPreservation([c1, c2], verified).preserved).toBe(true);
    const drift = assertIdPreservation([c1, c2], { claims: [{ id: c1 }, { id: claimId(99) }] });
    expect(drift.preserved).toBe(false);
    expect(drift.missingIds).toEqual([c2]);
    expect(drift.driftedIds).toEqual([claimId(99)]);
    expect(drift.requiresFullReverification).toBe(true);
  });

  it("plans a run-scoped delete plus verified insert with no orphan for dropped claims", () => {
    const pack = packWith([
      { id: claimId(101), text: "Corrected claim A", critical: true, segmentId: "segment-aaaaaaaa" },
      { id: claimId(102), text: "Corrected claim B", critical: false, segmentId: "segment-bbbbbbbb" },
    ]);
    const verified = buildVerifiedFactPack(pack, verificationWith(pack, new Set([claimId(102)])), { attempts: 3, verifierModel });
    const verifiedAt = new Date("2026-09-23T00:00:00.000Z");
    const plan = planClaimSetReplacement(runId, verified, verifierModel, { verifiedAt });
    expect(plan.deleteWhere.runId).toBe(runId);
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0]).toMatchObject({ runId, claim: "Corrected claim A", verifiedAt, verifierModel });
    expect(plan.droppedClaimIds).toEqual([claimId(102)]);
    expect(plan.insert.some((row) => row.claim === "Corrected claim B")).toBe(false);
  });
});
