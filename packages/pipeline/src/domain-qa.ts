import type { ApprovedScript, ConsolidatedReview, Domain, FactPack } from "@upcraft/contracts";

/**
 * Domain policy gates from `benchmarkstofocus.md`. These are deterministic
 * checks over locked artifacts; they back up, but never replace, the mandatory
 * clinician approval for medical content.
 */
export type DomainIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

const UNIT_PATTERN = /\b\d+(?:[.,]\d+)?\s?(?:kg|g|mg|µg|ug|km|cm|mm|nm|µm|um|ms|khz|mhz|hz|kpa|mpa|gpa|pa|kj|mj|kw|mw|gw|kv|ma|mol|ml|m\/s|m\/s²|m\/s2|m2|m²|m3|m³|j|n|v|a|w|s|k|c|°c|l)\b/i;
const ASSUMPTION_PATTERN = /\b(assum\w*|given that|treat\w*|neglect\w*|ideal|approximately|approximate|constant|ignoring)\b/i;
const CALCULATION_PATTERN = /[=×÷]|\d\s*[*+\-/^]\s*\d|\b(sum|total|therefore|hence|calculate|compute|ratio|rate)\b/i;

export const engineeringCorpus = (params: { script: ApprovedScript; factPack: FactPack; diagramLabels: string[] }) =>
  [
    params.factPack.claims.map((claim) => claim.text).join(" "),
    params.factPack.caveats.map((caveat) => caveat.text).join(" "),
    params.script.narration.map((line) => `${line.text} ${line.visualAction}`).join(" "),
    params.diagramLabels.join(" "),
  ].join(" ");

/** Engineering lessons must show units, assumptions, and calculation steps. */
export const validateEngineeringContent = (params: { domain: Domain; script: ApprovedScript; factPack: FactPack; diagramLabels: string[] }): DomainIssue[] => {
  if (params.domain !== "engineering") return [];
  const corpus = engineeringCorpus(params);
  const issues: DomainIssue[] = [];
  if (!UNIT_PATTERN.test(corpus)) {
    issues.push({ rule: "engineering-units-missing", evidence: {}, remediation: "State the quantities with explicit units before release; a wrong dimension is critical." });
  }
  if (!ASSUMPTION_PATTERN.test(corpus)) {
    issues.push({ rule: "engineering-assumptions-missing", evidence: {}, remediation: "State the assumptions and idealizations the calculation depends on." });
  }
  if (!CALCULATION_PATTERN.test(corpus)) {
    issues.push({ rule: "engineering-calculations-missing", evidence: {}, remediation: "Show the calculation steps, not only the result." });
  }
  return issues;
};

const AUTHORITATIVE_SOURCE = /(\.gov(?:\/|$)|\.edu(?:\/|$)|who\.int|nih\.gov|pubmed|ncbi|cdc\.gov|nhs\.uk|cancer\.gov|cochrane)/i;

/** Medical lessons require current, authoritative clinical sources. */
export const validateMedicalSources = (params: { domain: Domain; sources: Array<{ sourceUrl: string | null; url?: string | null; retrievedAt?: Date | null }> }): DomainIssue[] => {
  if (params.domain !== "medical") return [];
  if (!params.sources.length) {
    return [{ rule: "medical-sources-missing", evidence: {}, remediation: "Retrieve current authoritative clinical sources before a medical lesson may advance." }];
  }
  const authoritative = params.sources.filter((source) => AUTHORITATIVE_SOURCE.test(source.sourceUrl ?? source.url ?? ""));
  if (!authoritative.length) {
    return [{ rule: "medical-source-authority", evidence: { sources: params.sources.map((source) => source.sourceUrl ?? source.url ?? null) }, remediation: "Cite at least one authoritative clinical source; clinician approval remains the release authority." }];
  }
  return [];
};

/**
 * Deterministic reducer over the single consolidated Tier B review. Only
 * critical findings block release; advisory notes are recorded elsewhere. The
 * reducer cannot be satisfied by the planning model because the review is
 * separately routed.
 */
export const consolidatedReviewIssues = (review: ConsolidatedReview): DomainIssue[] =>
  review.issues
    .filter((issue) => issue.severity === "critical")
    .map((issue) => ({ rule: `consolidated-${issue.domain}-critical`, evidence: { evidence: issue.evidence }, remediation: issue.remediation }));

export type RightedAsset = { role: string; provenance: Record<string, unknown> | null };

/** Production-company work needs a rights/provenance record for every asset. */
export const validateClientAssetRights = (params: { domain: Domain; assets: RightedAsset[] }): DomainIssue[] => {
  if (params.domain !== "client-production") return [];
  const missing = params.assets.filter((asset) => !asset.provenance || !("rights" in asset.provenance) || !asset.provenance.rights).map((asset) => asset.role);
  if (!missing.length) return [];
  return [{ rule: "client-rights-record-missing", evidence: { roles: missing }, remediation: "Record a rights/provenance entry for every third-party asset before release." }];
};

/** Client work additionally requires an explicit client style approval. */
export const validateClientStyleApproval = (params: { domain: Domain; approvals: Array<{ decision: string; notes: string | null }> }): DomainIssue[] => {
  if (params.domain !== "client-production") return [];
  const styleApproved = params.approvals.some((approval) => approval.decision === "approved" && /style/i.test(approval.notes ?? ""));
  if (styleApproved) return [];
  return [{ rule: "client-style-approval-missing", evidence: {}, remediation: "Obtain explicit client style approval and record it before release." }];
};
