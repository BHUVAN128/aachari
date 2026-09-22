import { DomainSchema, type Domain } from "@upcraft/contracts";

/**
 * Deterministic domain-validation fallback (Point 5, promoted).
 *
 * Domain classification was a single LLM opinion frozen into the immutable
 * snapshot with no deterministic check. This keyword scorer validates the agent's
 * classification: it overrides only on a clear signal and records the evidence,
 * and defers to the agent when no keyword fires. Medical/health phrasing maps to
 * `standard` because there is no medical classification.
 */

/** Deterministic tie-break order; the agent's own pick wins any tie it is part of. */
export const DOMAIN_PRECEDENCE: readonly Domain[] = [
  "engineering",
  "legal-compliance",
  "stem",
  "business",
  "humanities",
  "client-production",
  "standard",
];

export const DOMAIN_KEYWORD_TABLE: Record<Domain, readonly string[]> = {
  engineering: [
    "circuit", "voltage", "current", "resistor", "capacitor", "transistor", "semiconductor", "microcontroller",
    "thermodynamics", "torque", "stress", "strain", "cad", "beam", "load", "gear", "turbine", "hydraulic", "actuator",
  ],
  stem: [
    "physics", "chemistry", "biology", "math", "mathematics", "calculus", "algebra", "geometry", "statistics",
    "photosynthesis", "cell", "atom", "molecule", "enzyme", "ecosystem", "gene", "evolution", "quantum", "reaction",
  ],
  humanities: [
    "history", "literature", "philosophy", "poetry", "essay", "civilization", "revolution", "ethics", "linguistics", "art history",
  ],
  "legal-compliance": [
    "law", "legal", "contract", "compliance", "regulation", "gdpr", "hipaa", "litigation", "statute", "liability", "policy wording",
  ],
  business: [
    "business", "finance", "marketing", "economics", "entrepreneurship", "accounting", "revenue", "startup", "supply chain",
  ],
  "client-production": [
    "client", "brand", "campaign", "stakeholder", "deliverable", "agency", "promo", "commercial", "white-label", "brand guidelines", "sponsor",
  ],
  standard: [
    "patient", "clinical", "medical", "disease", "diagnosis", "drug", "anatomy", "physiology", "grammar", "geography", "study skills",
  ],
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keywordPattern = (keyword: string) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");

export type DomainClassification = {
  domain: Domain;
  agentDomain: Domain;
  heuristicDomain: Domain;
  override: boolean;
  matchedKeywords: string[];
};

/**
 * Validates the agent's domain against deterministic keyword evidence. Defers to
 * the agent when no keyword fires; ties prefer the agent's own pick, then
 * `DOMAIN_PRECEDENCE` order. Throws on a value outside the approved enum.
 */
export const validateDomainClassification = (params: { agentDomain: Domain; requestText: string }): DomainClassification => {
  const agentDomain = DomainSchema.parse(params.agentDomain);
  const matches = {} as Record<Domain, string[]>;
  for (const domain of DOMAIN_PRECEDENCE) matches[domain] = DOMAIN_KEYWORD_TABLE[domain].filter((keyword) => keywordPattern(keyword).test(params.requestText));
  const scores = DOMAIN_PRECEDENCE.map((domain) => ({ domain, score: matches[domain].length }));
  const best = Math.max(0, ...scores.map((entry) => entry.score));
  if (best === 0) return { domain: agentDomain, agentDomain, heuristicDomain: agentDomain, override: false, matchedKeywords: [] };
  const tied = scores.filter((entry) => entry.score === best).map((entry) => entry.domain);
  const heuristicDomain = tied.includes(agentDomain) ? agentDomain : tied[0]!;
  return { domain: heuristicDomain, agentDomain, heuristicDomain, override: heuristicDomain !== agentDomain, matchedKeywords: [...new Set(tied.flatMap((domain) => matches[domain]))] };
};
