import { DomainSchema, type Domain } from "@upcraft/contracts";

/**
 * Intake hardening — deterministic domain-validation fallback (Point 5, code half).
 *
 * Domain classification is a single LLM opinion that freezes into the immutable
 * snapshot with no deterministic check. The approved domain set stays exactly
 * `standard | engineering | client-production` (the taxonomy-expansion part of
 * Point 5 is a policy change and is deferred pending explicit approval), and
 * medical topics are standard by policy — there is no medical classification.
 *
 * This keyword-heuristic scorer only *validates* the agent's classification. When
 * a clear keyword signal contradicts the agent it overrides the domain and records
 * the evidence so the decision is reproducible; when there is no signal it defers
 * to the agent rather than guessing. Pure function, no provider call.
 */

const DOMAIN_PRECEDENCE: readonly Domain[] = ["engineering", "client-production", "standard"];

/**
 * Sample keyword vocabulary for the approved domains. This is deliberately a
 * heuristic, not a taxonomy: it exists to catch an obviously wrong freeze, not to
 * replace extraction. Legal/compliance phrasing intentionally maps to `standard`
 * until the taxonomy expansion (Point 5b) is approved.
 */
export const DOMAIN_KEYWORD_TABLE: Record<Domain, readonly string[]> = {
  engineering: [
    "circuit", "voltage", "current", "resistor", "capacitor", "transistor", "semiconductor", "microcontroller",
    "algorithm", "compiler", "database", "api", "software", "code", "unit test", "architecture",
    "thermodynamics", "torque", "stress", "strain", "cad", "beam", "load", "gear", "turbine", "hydraulic",
  ],
  "client-production": [
    "client", "brand", "campaign", "stakeholder", "deliverable", "agency", "marketing", "promo",
    "commercial", "white-label", "brand guidelines", "sponsor",
  ],
  standard: [
    "photosynthesis", "cell", "atom", "molecule", "grammar", "history", "geography", "poem",
    "patient", "clinical", "medical", "disease", "diagnosis", "drug", "anatomy", "physiology",
  ],
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keywordPattern = (keyword: string) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");

/** The keywords from the table that actually occur in the request text. */
export const matchDomainKeywords = (requestText: string): Record<Domain, string[]> => {
  const matches = {} as Record<Domain, string[]>;
  for (const domain of Object.keys(DOMAIN_KEYWORD_TABLE) as Domain[]) {
    matches[domain] = DOMAIN_KEYWORD_TABLE[domain].filter((keyword) => keywordPattern(keyword).test(requestText));
  }
  return matches;
};

export type DomainClassification = {
  /** The domain to freeze after validation. */
  domain: Domain;
  /** The domain the agent proposed (schema-validated). */
  agentDomain: Domain;
  /** The heuristic's own pick; equals `agentDomain` when there was no signal. */
  heuristicDomain: Domain;
  /** True when the heuristic overrode the agent. */
  override: boolean;
  /** Keywords that fired, for the recorded evidence. */
  matchedKeywords: string[];
};

/**
 * Validates the agent's domain against deterministic keyword evidence. Defers to
 * the agent when no keyword fires anywhere (absence of signal is not a
 * disagreement). Throws on a domain outside the approved enum, because that is a
 * contract violation rather than a routing disagreement.
 */
export const validateDomainClassification = (params: { agentDomain: Domain; requestText: string }): DomainClassification => {
  const agentDomain = DomainSchema.parse(params.agentDomain);
  const matches = matchDomainKeywords(params.requestText);
  const scores = DOMAIN_PRECEDENCE.map((domain) => ({ domain, score: matches[domain].length }));
  const best = Math.max(0, ...scores.map((entry) => entry.score));
  if (best === 0) {
    return { domain: agentDomain, agentDomain, heuristicDomain: agentDomain, override: false, matchedKeywords: [] };
  }
  const tied = scores.filter((entry) => entry.score === best).map((entry) => entry.domain);
  const heuristicDomain = tied.includes(agentDomain) ? agentDomain : tied[0]!;
  const matchedKeywords = [...new Set(tied.flatMap((domain) => matches[domain]))];
  return { domain: heuristicDomain, agentDomain, heuristicDomain, override: heuristicDomain !== agentDomain, matchedKeywords };
};
