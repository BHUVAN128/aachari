import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, FactPackSchema, PedagogyReviewSchema } from "@upcraft/contracts";
import { pedagogyReviewIssues, validateClientAssetRights, validateClientStyleApproval, validateEngineeringContent, validateMedicalSources } from "../src/domain-qa.ts";

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

describe("medical source-quality gate", () => {
  it("requires at least one authoritative clinical source", () => {
    expect(validateMedicalSources({ domain: "medical", sources: [] }).map((issue) => issue.rule)).toContain("medical-sources-missing");
    expect(validateMedicalSources({ domain: "medical", sources: [{ sourceUrl: "https://example.com/blog" }] }).map((issue) => issue.rule)).toContain("medical-source-authority");
    expect(validateMedicalSources({ domain: "medical", sources: [{ sourceUrl: "https://www.nih.gov/study" }] })).toEqual([]);
  });

  it("is inert for non-medical domains", () => {
    expect(validateMedicalSources({ domain: "standard", sources: [] })).toEqual([]);
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

describe("pedagogy review gate", () => {
  const review = (overrides: Record<string, unknown> = {}) => PedagogyReviewSchema.parse({ schemaVersion: "pedagogy-review/v1", objectiveCovered: true, oneIdeaPerBeat: true, readingLevelAppropriate: true, issues: [], ...overrides });

  it("accepts a clean review", () => {
    expect(pedagogyReviewIssues(review())).toEqual([]);
  });

  it("blocks release on a critical pedagogy defect", () => {
    const issues = pedagogyReviewIssues(review({ issues: [{ severity: "critical", evidence: "Scene 2 teaches two ideas at once", remediation: "Split the beat" }] }));
    expect(issues.map((issue) => issue.rule)).toContain("pedagogy-critical");
  });

  it("blocks release when a mandatory pedagogy check fails", () => {
    const rules = pedagogyReviewIssues(review({ objectiveCovered: false, oneIdeaPerBeat: false, readingLevelAppropriate: false })).map((issue) => issue.rule);
    expect(rules).toEqual(expect.arrayContaining(["pedagogy-objective-not-covered", "pedagogy-multiple-ideas-per-beat", "pedagogy-reading-level"]));
  });

  it("does not block on advisory info or warning notes", () => {
    expect(pedagogyReviewIssues(review({ issues: [{ severity: "info", evidence: "Nice hook", remediation: "Keep" }, { severity: "warning", evidence: "Could add a recap", remediation: "Optional" }] }))).toEqual([]);
  });
});
