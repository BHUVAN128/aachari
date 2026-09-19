import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, ClaimVerificationSchema, FactPackSchema, ScriptVerificationSchema } from "@upcraft/contracts";
import { assertClaimVerificationComplete, assertScriptVerificationComplete, unsupportedClaimIds } from "../src/verification.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const claimId = "44444444-4444-4444-8444-444444444444";
const otherClaimId = "55555555-5555-4555-8555-555555555555";
const sceneId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";

const factPack = FactPackSchema.parse({
  schemaVersion: "fact-pack/v2",
  claims: [
    { id: claimId, text: "Light energy becomes chemical energy", evidence: { sourceId, sourceHash: "a".repeat(64), segmentIds: ["segment-one"], locator: "p1" }, critical: true },
    { id: otherClaimId, text: "Photosynthesis stores energy", evidence: { sourceId, sourceHash: "a".repeat(64), segmentIds: ["segment-two"], locator: "p2" }, critical: false },
  ],
  caveats: [],
});

const claimVerification = (evidence: Array<{ claimId: string; sourceId?: string; supported?: boolean }>) => ClaimVerificationSchema.parse({
  schemaVersion: "claim-verification/v2",
  notes: [],
  evidence: evidence.map((entry) => ({ claimId: entry.claimId, sourceId: entry.sourceId ?? sourceId, segmentIds: ["segment-one"], supported: entry.supported ?? true, rationale: "checked" })),
});

const script = ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [{ id: lineId, sceneId, text: "Light energy becomes chemical energy.", claimIds: [claimId], visualAction: "Reveal" }] });
const scriptVerification = (evidence: Array<{ lineId: string; supported?: boolean; unsupportedClaimIds?: string[] }>) => ScriptVerificationSchema.parse({
  schemaVersion: "script-verification/v2",
  notes: [],
  evidence: evidence.map((entry) => ({ lineId: entry.lineId, supported: entry.supported ?? true, unsupportedClaimIds: entry.unsupportedClaimIds ?? [], rationale: "checked" })),
});

describe("fact verification reducer", () => {
  it("accepts a complete, supported verification and reports no unsupported claims", () => {
    const verification = claimVerification([{ claimId }, { claimId: otherClaimId }]);
    expect(unsupportedClaimIds(verification)).toEqual([]);
    expect(() => assertClaimVerificationComplete(verification, factPack)).not.toThrow();
  });

  it("rejects a verification that skips a claim", () => {
    expect(() => assertClaimVerificationComplete(claimVerification([{ claimId }]), factPack)).toThrow("every fact-pack claim exactly once");
  });

  it("rejects an unsupported claim", () => {
    const verification = claimVerification([{ claimId, supported: false }, { claimId: otherClaimId }]);
    expect(unsupportedClaimIds(verification)).toEqual([claimId]);
    expect(() => assertClaimVerificationComplete(verification, factPack)).toThrow("rejected claims");
  });

  it("rejects a verification that changed the evidence source identity", () => {
    const verification = claimVerification([{ claimId, sourceId: "99999999-9999-4999-8999-999999999999" }, { claimId: otherClaimId }]);
    expect(() => assertClaimVerificationComplete(verification, factPack)).toThrow("changed evidence identity");
  });
});

describe("script verification reducer", () => {
  it("accepts a complete, supported script verification", () => {
    expect(() => assertScriptVerificationComplete(scriptVerification([{ lineId }]), script)).not.toThrow();
  });

  it("rejects an unsupported narration line", () => {
    expect(() => assertScriptVerificationComplete(scriptVerification([{ lineId, supported: false }]), script)).toThrow("rejected unsupported narration");
  });

  it("rejects an unsupported claim reference attached to a line", () => {
    expect(() => assertScriptVerificationComplete(scriptVerification([{ lineId, unsupportedClaimIds: [claimId] }]), script)).toThrow("rejected unsupported narration");
  });

  it("rejects a verification that skips a line", () => {
    expect(() => assertScriptVerificationComplete(scriptVerification([{ lineId: "77777777-7777-4777-8777-777777777777" }]), script)).toThrow("every script line exactly once");
  });
});
