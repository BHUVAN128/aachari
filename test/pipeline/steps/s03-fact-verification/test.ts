import assert from "node:assert/strict";
import { ClaimVerificationSchema, FactPackSchema, SourceEvidenceMapSchema, type ClaimVerification, type FactPack } from "@upcraft/contracts";
import {
  MAX_VERIFIER_ATTEMPTS,
  VERIFIER_REJECTION_EXHAUSTED,
  VerifierRejectionExhaustedError,
  assertClaimVerificationCompleteWithRejection,
  assertIdPreservation,
  runBoundedVerifierLoop,
  type CorrectionPrompt,
} from "./verifier-loop.ts";
import {
  FACT_PACK_CORRECTION_CONTRACT,
  buildVerifiedFactPack,
  classifyVerification,
  runClaimVerificationPolicyLoop,
} from "./claim-policy.ts";
import { withEvidenceWindow } from "./context-window.ts";
import { VerifierJsonError, parseVerifierJson } from "./json-extraction.ts";
import { planClaimSetReplacement } from "./claim-store.ts";

/**
 * s03 — Fact verification.
 *
 * Deterministic suite (no provider call):
 *   1. Gap 1 accept-after-correction and exhaustion sequences.
 *   2. Claim policy: critical failures go to the repair channel and are never
 *      dropped; non-critical failures drop as recorded omissions only at
 *      exhaustion; a 24/25 mixed pack costs exactly two generator runs.
 *   3. Correction contract + ID-drift graceful degradation.
 *   4. Claim-local evidence window (neighbours, cross-source isolation, budget).
 *   5. Verifier JSON extraction (fenced / trailing commentary / malformed).
 *   6. Claim-set replacement (attempt-2 rows replace attempt-1; no drop orphans).
 */
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID_B = "22222222-2222-4222-8222-222222222222";
const SOURCE_HASH = "a".repeat(64);
const SOURCE_HASH_B = "b".repeat(64);
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "99999999-9999-4999-8999-999999999999";
const VERIFIER_MODEL = "gemini/gemini-3.8-flash";

const claimId = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const buildFactPack = (c3Text: string) => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [
    { id: C1, text: "Leaves contain chlorophyll.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-aaaaaaaa"], locator: "p1" }, critical: true },
    { id: C2, text: "Stomata let carbon dioxide enter.", evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-bbbbbbbb"], locator: "p2" }, critical: true },
    { id: C3, text: c3Text, evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: ["segment-cccccccc"], locator: "p3" }, critical: true },
  ],
  caveats: [{ text: "Use context." }],
});

const packWith = (claims: Array<{ id: string; text: string; critical: boolean; segmentId: string }>): FactPack => FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: claims.map((claim) => ({ id: claim.id, text: claim.text, evidence: { sourceId: SOURCE_ID, sourceHash: SOURCE_HASH, segmentIds: [claim.segmentId], locator: "p" }, critical: claim.critical })),
  caveats: [{ text: "Use context." }],
});

const verificationWith = (pack: FactPack, unsupported: Set<string>, rationale = "The cited segment does not state this claim."): ClaimVerification => ClaimVerificationSchema.parse({
  schemaVersion: "claim-verification/v2",
  evidence: pack.claims.map((claim) => ({ claimId: claim.id, sourceId: claim.evidence.sourceId, segmentIds: claim.evidence.segmentIds, supported: !unsupported.has(claim.id), rationale: unsupported.has(claim.id) ? rationale : "Supported by the cited segment." })),
  notes: [],
});

/** The verifier rejects C-3 while its text is unrepaired, otherwise accepts. */
const verifyWith = (factPack: FactPack) => {
  const c3 = factPack.claims.find((claim) => claim.id === C3)!;
  const rejected = !c3.text.includes("corrected");
  const verification = verificationWith(factPack, rejected ? new Set([C3]) : new Set());
  assertClaimVerificationCompleteWithRejection(verification, factPack);
};

const mapFor = (sources: Array<{ sourceId: string; hash: string; texts: string[] }>) => SourceEvidenceMapSchema.parse({
  schemaVersion: "source-evidence-map/v1",
  sources: sources.map((source) => {
    let offset = 0;
    const segments = source.texts.map((text, ordinal) => {
      const segment = { id: `seg-${source.sourceId.slice(0, 4)}-${String(ordinal).padStart(4, "0")}`, sourceId: source.sourceId, sourceHash: source.hash, ordinal, startOffset: offset, endOffset: offset + text.length, text };
      offset += text.length;
      return segment;
    });
    return { sourceId: source.sourceId, sourceHash: source.hash, segments };
  }),
});

const main = async () => {
  // --- Gap 1: accept-after-correction ---
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
  assert.match(corrections[0]!.contract, /preserve every accepted id verbatim/);
  assert.ok(accepted.value.claims.find((claim) => claim.id === C3)!.text.includes("corrected"));
  console.log(`  Gap 1: accept-after-correction sequence = ${attempts.map((entry) => entry.outcome).join(" → ")}`);

  // --- Gap 1: exhaustion ---
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

  // --- A1: classification channels ---
  const channelPack = packWith([
    { id: C1, text: "Supported critical claim.", critical: true, segmentId: "segment-aaaaaaaa" },
    { id: C2, text: "Rejected critical claim.", critical: true, segmentId: "segment-bbbbbbbb" },
    { id: C3, text: "Rejected non-critical claim.", critical: false, segmentId: "segment-cccccccc" },
  ]);
  const classification = classifyVerification(verificationWith(channelPack, new Set([C2, C3])), channelPack);
  assert.deepEqual(classification.verifiedClaims.map((claim) => claim.id), [C1]);
  assert.deepEqual(classification.repairClaimIds, [C2, C3], "both critical and non-critical rejections enter the repair channel");
  assert.deepEqual(classification.criticalRejections, [C2]);
  assert.deepEqual(classification.dropCandidates, [C3]);
  console.log(`  A1: channels → repair [${classification.repairClaimIds.length}], drop-candidates [${classification.dropCandidates.length}], critical [${classification.criticalRejections.length}]`);

  // --- A1: mixed 24/25 pack costs exactly two generator runs ---
  const totalClaims = 25;
  const baseClaims = Array.from({ length: totalClaims }, (_, index) => ({ id: claimId(index + 1), text: `Claim number ${index + 1}`, critical: false, segmentId: `segment-${String(index + 1).padStart(8, "0")}` }));
  const rejectedMixedId = claimId(13);
  let generatorCalls = 0;
  const mixedCorrections: CorrectionPrompt[] = [];
  const mixed = await runClaimVerificationPolicyLoop({
    factPack: packWith(baseClaims),
    generate: async (correction) => {
      generatorCalls += 1;
      if (correction) mixedCorrections.push(correction);
      return packWith(baseClaims.map((claim) => (claim.id === rejectedMixedId && correction ? { ...claim, text: `${claim.text} repaired` } : claim)));
    },
    verify: (pack) => {
      const target = pack.claims.find((claim) => claim.id === rejectedMixedId)!;
      return verificationWith(pack, target.text.includes("repaired") ? new Set() : new Set([rejectedMixedId]));
    },
    verifierModel: VERIFIER_MODEL,
  });
  assert.equal(generatorCalls, 2, "a 24/25 pack must cost exactly two generator runs, not one per rejected claim");
  assert.deepEqual(mixed.attempts.map((entry) => entry.outcome), ["rejected-by-verifier", "completed"]);
  assert.deepEqual(mixedCorrections[0]!.rejectedIds, [rejectedMixedId]);
  assert.equal(mixedCorrections[0]!.contract, FACT_PACK_CORRECTION_CONTRACT);
  assert.equal(mixed.verifiedFactPack.claims.length, totalClaims);
  assert.equal(mixed.verifiedFactPack.omissions.length, 0);
  console.log(`  A1: mixed pack → ${generatorCalls} generator runs, ${mixed.verifiedFactPack.claims.length} verified, ${mixed.verifiedFactPack.omissions.length} omissions`);

  // --- A1: non-critical exhaustion drops with an omission ---
  const dropPack = packWith([
    { id: C1, text: "Supported critical claim.", critical: true, segmentId: "segment-aaaaaaaa" },
    { id: C3, text: "Unsupported non-critical claim.", critical: false, segmentId: "segment-cccccccc" },
  ]);
  const dropped = await runClaimVerificationPolicyLoop({
    factPack: dropPack,
    generate: async () => dropPack,
    verify: (pack) => verificationWith(pack, new Set([C3])),
    verifierModel: VERIFIER_MODEL,
  });
  assert.deepEqual(dropped.attempts.map((entry) => entry.outcome), ["rejected-by-verifier", "rejected-by-verifier", "exhausted-non-critical-drop"]);
  assert.deepEqual(dropped.droppedClaimIds, [C3]);
  assert.deepEqual(dropped.verifiedFactPack.claims.map((claim) => claim.id), [C1]);
  assert.equal(dropped.verifiedFactPack.omissions.length, 1);
  assert.equal(dropped.verifiedFactPack.omissions[0]!.claimId, C3);
  assert.equal(dropped.verifiedFactPack.omissions[0]!.text, "Unsupported non-critical claim.");
  assert.equal(dropped.verifiedFactPack.omissions[0]!.attempts, MAX_VERIFIER_ATTEMPTS);
  console.log(`  A1: non-critical exhaustion → dropped [${dropped.droppedClaimIds.join(", ")}] with omission recorded`);

  // --- A1: critical exhaustion is terminal and never drops ---
  const criticalPack = packWith([
    { id: C2, text: "Unsupported critical claim.", critical: true, segmentId: "segment-bbbbbbbb" },
  ]);
  let criticalTerminal: unknown = null;
  try {
    await runClaimVerificationPolicyLoop({
      factPack: criticalPack,
      generate: async () => criticalPack,
      verify: (pack) => verificationWith(pack, new Set([C2])),
      verifierModel: VERIFIER_MODEL,
    });
  } catch (error) {
    criticalTerminal = error;
  }
  assert.ok(criticalTerminal instanceof VerifierRejectionExhaustedError, "critical exhaustion must fail the run terminally");
  assert.equal((criticalTerminal as VerifierRejectionExhaustedError).code, VERIFIER_REJECTION_EXHAUSTED);
  console.log(`  A1: critical exhaustion → terminal ${VERIFIER_REJECTION_EXHAUSTED} (claim never dropped)`);

  // --- A5: ID preservation: drift triggers full re-verification, never a failure ---
  const preserved = assertIdPreservation([C1, C2], packWith([
    { id: C1, text: "One.", critical: true, segmentId: "segment-aaaaaaaa" },
    { id: C2, text: "Two.", critical: true, segmentId: "segment-bbbbbbbb" },
  ]));
  assert.equal(preserved.preserved, true);
  const drifted = assertIdPreservation([C1, C2], { claims: [{ id: C1 }, { id: claimId(99) }] });
  assert.equal(drifted.preserved, false);
  assert.deepEqual(drifted.missingIds, [C2]);
  assert.deepEqual(drifted.driftedIds, [claimId(99)]);
  assert.equal(drifted.requiresFullReverification, true);

  const driftRepairPack = (repaired: boolean): FactPack => packWith([
    { id: C1, text: "Stable critical claim.", critical: true, segmentId: "segment-aaaaaaaa" },
    repaired
      ? { id: claimId(77), text: "Repaired claim with a brand-new id.", critical: true, segmentId: "segment-bbbbbbbb" }
      : { id: C2, text: "Original claim.", critical: true, segmentId: "segment-bbbbbbbb" },
  ]);
  const driftRun = await runClaimVerificationPolicyLoop({
    factPack: driftRepairPack(false),
    generate: async (correction) => driftRepairPack(Boolean(correction)),
    verify: (pack) => verificationWith(pack, pack.claims.some((claim) => claim.id === C2) ? new Set([C2]) : new Set()),
    verifierModel: VERIFIER_MODEL,
  });
  assert.equal(driftRun.verifiedFactPack.claims.length, 2);
  assert.equal(driftRun.attempts[1]!.idPreservation?.requiresFullReverification, true, "an ID-drifting repair must degrade to full re-verification");
  console.log("  A5: ID drift → full re-verification recorded, run proceeds");

  // --- A2: claim-local evidence window ---
  const mapA = mapFor([{ sourceId: SOURCE_ID, hash: SOURCE_HASH, texts: ["alpha ".repeat(5), "the cited sentence.", "omega ".repeat(5)] }]);
  const citedSegA = mapA.sources[0]!.segments[1]!.id;
  const window = withEvidenceWindow(packWith([{ id: C1, text: "Claim citing the middle segment.", critical: true, segmentId: citedSegA }]), mapA);
  assert.deepEqual(window.evidenceSegments.map((segment) => segment.ordinal), [0, 1, 2], "±1 ordinal neighbours must be pulled within the same source");
  assert.deepEqual(window.evidenceSegments.filter((segment) => segment.cited).map((segment) => segment.ordinal), [1]);
  assert.equal(window.manifest.citedSegments, 1);
  assert.equal(window.manifest.neighborSegments, 2);
  console.log(`  A2: neighbours → cited ${window.manifest.citedSegments}, neighbour ${window.manifest.neighborSegments}`);

  const mapAB = mapFor([
    { sourceId: SOURCE_ID, hash: SOURCE_HASH, texts: ["a1", "a2", "a3"] },
    { sourceId: SOURCE_ID_B, hash: SOURCE_HASH_B, texts: ["b1", "b2", "b3"] },
  ]);
  const citedSegAB = mapAB.sources[0]!.segments[1]!.id;
  const crossSource = withEvidenceWindow(packWith([{ id: C1, text: "Claim on source A.", critical: true, segmentId: citedSegAB }]), mapAB);
  assert.ok(crossSource.evidenceSegments.every((segment) => segment.sourceId === SOURCE_ID), "a neighbour must never cross into another source");
  console.log(`  A2: cross-source isolation → ${crossSource.evidenceSegments.length} segments, all from source A`);

  const mapBudget = mapFor([{ sourceId: SOURCE_ID, hash: SOURCE_HASH, texts: ["n".repeat(200), "small cite", "x".repeat(1_000)] }]);
  const budgetCited = mapBudget.sources[0]!.segments[1]!.id;
  const budgetWindow = withEvidenceWindow(packWith([{ id: C1, text: "Budgeted claim.", critical: true, segmentId: budgetCited }]), mapBudget, { maxWindowChars: 250 });
  assert.ok(budgetWindow.manifest.totalChars <= 250, "the hard character budget must be respected");
  assert.equal(budgetWindow.manifest.omittedNeighborSegments, 1, "a neighbour that does not fit is omitted, never truncated");
  assert.ok(budgetWindow.evidenceSegments.some((segment) => segment.cited), "cited evidence is always included");
  console.log(`  A2: budget → total ${budgetWindow.manifest.totalChars}/${budgetWindow.manifest.budgetChars} chars, ${budgetWindow.manifest.omittedNeighborSegments} neighbour omitted`);

  // --- A3: verifier JSON extraction ---
  assert.deepEqual(parseVerifierJson('{"supported":true}'), { supported: true });
  assert.deepEqual(parseVerifierJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseVerifierJson('{"a":1} trailing commentary'), { a: 1 }, "trailing commentary after a balanced object is tolerated");
  assert.throws(() => parseVerifierJson("{bad json}"), VerifierJsonError, "malformed JSON must throw, never be repaired");
  assert.throws(() => parseVerifierJson("no json here"), VerifierJsonError);
  assert.throws(() => parseVerifierJson('{"a":1}{"b":2}'), VerifierJsonError, "ambiguous multiple objects must throw");
  console.log("  A3: fenced / trailing / clean parsed; malformed and ambiguous throw");

  // --- A4: claim-set replacement ---
  const attempt2Pack = packWith([
    { id: claimId(101), text: "Corrected claim A", critical: true, segmentId: "segment-aaaaaaaa" },
    { id: claimId(102), text: "Corrected claim B", critical: false, segmentId: "segment-bbbbbbbb" },
  ]);
  const verified = buildVerifiedFactPack(attempt2Pack, verificationWith(attempt2Pack, new Set([claimId(102)])), { attempts: 3, verifierModel: VERIFIER_MODEL });
  assert.equal(verified.omissions[0]!.attempts, 3);
  assert.match(verified.omissions[0]!.rationale, /does not state this claim/);
  const verifiedAt = new Date("2026-09-23T00:00:00.000Z");
  const plan = planClaimSetReplacement(RUN_ID, verified, VERIFIER_MODEL, { verifiedAt });
  assert.equal(plan.deleteWhere.runId, RUN_ID, "the whole run's prior claim rows are deleted before insert");
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.insert[0]!.runId, RUN_ID);
  assert.equal(plan.insert[0]!.claim, "Corrected claim A");
  assert.equal(plan.insert[0]!.verifiedAt, verifiedAt);
  assert.equal(plan.insert[0]!.verifierModel, VERIFIER_MODEL);
  assert.deepEqual(plan.droppedClaimIds, [claimId(102)]);
  assert.ok(!plan.insert.some((row) => row.claim === "Corrected claim B"), "a dropped claim must leave no orphan row");
  console.log(`  A4: replacement → ${plan.insert.length} insert rows for run, ${plan.droppedClaimIds.length} dropped with no orphan`);

  console.log("s03 PASS");
};

main().catch((error) => {
  console.error("s03 FAIL:", error);
  process.exit(1);
});
