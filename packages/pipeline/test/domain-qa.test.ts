import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, ConsolidatedReviewSchema, FactPackSchema } from "@upcraft/contracts";
import { consolidatedReviewIssues, validateClientAssetRights, validateClientStyleApproval, validateEngineeringContent } from "../src/domain-qa.ts";

const sceneId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";
const claimId = "44444444-4444-4444-8444-444444444444";
const sourceId = "11111111-1111-4111-8111-111111111111";

const script = (text: string) => ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [{ id: lineId, sceneId, text, claimIds: [claimId], visualAction: "show the relationship" }] });
const factPack = (text: string) => FactPackSchema.parse({ schemaVersion: "fact-pack/v2", claims: [{ id: claimId, text, evidence: { sourceId, sourceHash: "a".repeat(64), segmentIds: ["segment-one"], locator: "p1" }, critical: true }], caveats: [] });

describe("engineering domain gate", () => {
  it("is inert for non-engineering domains", () => {
    expect(validateEngineeringContent({ domain: "standard", script: script("A leaf makes food."), factPack: factPack("A leaf makes food."), diagramLabels: [] })).toEqual([]);
  });

  it("requires units, assumptions, and calculation steps", () => {
    const rules = validateEngineeringContent({ domain: "engineering", script: script("The beam bends."), factPack: factPack("The beam bends."), diagramLabels: [] }).map((issue) => issue.rule);
    expect(rules).toContain("engineering-units-missing");
    expect(rules).toContain("engineering-assumptions-missing");
    expect(rules).toContain("engineering-calculations-missing");
  });

  it("passes when the lesson states units, assumptions, and a calculation", () => {
    const text = "Assume the load is constant at 20 N, so the stress = 20 / 0.5 = 40 Pa";
    expect(validateEngineeringContent({ domain: "engineering", script: script(text), factPack: factPack(text), diagramLabels: ["stress = 40 Pa"] })).toEqual([]);
  });
});

describe("client-production gates", () => {
  it("requires a rights record for every asset", () => {
    const rules = validateClientAssetRights({ domain: "client-production", assets: [{ role: "diagram-1", provenance: { kind: "typed-svg" } }] }).map((issue) => issue.rule);
    expect(rules).toContain("client-rights-record-missing");
    expect(validateClientAssetRights({ domain: "client-production", assets: [{ role: "diagram-1", provenance: { rights: "licensed" } }] })).toEqual([]);
  });

  it("requires an explicit client style approval", () => {
    expect(validateClientStyleApproval({ domain: "client-production", approvals: [{ decision: "approved", notes: "looks fine" }] }).map((issue) => issue.rule)).toContain("client-style-approval-missing");
    expect(validateClientStyleApproval({ domain: "client-production", approvals: [{ decision: "approved", notes: "Client style approved 2026-09" }] })).toEqual([]);
  });

  it("is inert for non-client domains", () => {
    expect(validateClientAssetRights({ domain: "standard", assets: [{ role: "x", provenance: {} }] })).toEqual([]);
    expect(validateClientStyleApproval({ domain: "standard", approvals: [] })).toEqual([]);
  });
});

describe("consolidated review gate", () => {
  const review = (overrides: Record<string, unknown> = {}) => ConsolidatedReviewSchema.parse({ schemaVersion: "consolidated-review/v1", issues: [], ...overrides });

  it("accepts a clean consolidated review", () => {
    expect(consolidatedReviewIssues(review())).toEqual([]);
  });

  it("blocks release on a critical finding and names its domain", () => {
    const rules = consolidatedReviewIssues(review({ issues: [{ domain: "factual", severity: "critical", evidence: "Claim 3 is unsupported", remediation: "Remove the claim" }] })).map((issue) => issue.rule);
    expect(rules).toContain("consolidated-factual-critical");
  });

  it("blocks release on critical findings from any domain", () => {
    const rules = consolidatedReviewIssues(review({ issues: [
      { domain: "pedagogy", severity: "critical", evidence: "Scene 2 teaches two ideas at once", remediation: "Split the beat" },
      { domain: "visual", severity: "critical", evidence: "Diagram label is illegible", remediation: "Enlarge the label" },
      { domain: "audio", severity: "critical", evidence: "Narration is clipped", remediation: "Regenerate the audio" },
    ] })).map((issue) => issue.rule);
    expect(rules).toEqual(expect.arrayContaining(["consolidated-pedagogy-critical", "consolidated-visual-critical", "consolidated-audio-critical"]));
  });

  it("does not block on advisory info or warning notes", () => {
    expect(consolidatedReviewIssues(review({ issues: [{ domain: "pedagogy", severity: "info", evidence: "Nice hook", remediation: "Keep" }, { domain: "visual", severity: "warning", evidence: "Could add a recap", remediation: "Optional" }] }))).toEqual([]);
  });
});
