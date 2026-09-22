import { z } from "zod";
import { classifyDomainByKeywords, type DomainClassification } from "./domain-routing.ts";

/**
 * Intake hardening — domain taxonomy expansion (Point 5, policy half).
 *
 * The approved `standard | engineering | client-production` taxonomy is narrow for
 * broad coverage. This sandbox prototype widens it and extends the deterministic
 * fallback vocabulary. It changes a named policy surface (`DomainSchema` and the
 * `run_domain` DB enum), so it is proven here first and promoted as a separate,
 * explicitly approved change.
 *
 * Medical/health topics are **not** a domain: per `AGENTS.md` and the process
 * document they remain `standard` educational topics. The keyword table routes
 * health phrasing to `standard` deliberately.
 */

export const SandboxDomainSchema = z.enum([
  "standard",
  "engineering",
  "client-production",
  "stem",
  "humanities",
  "legal-compliance",
  "business",
]);
export type SandboxDomain = z.infer<typeof SandboxDomainSchema>;

/** Deterministic tie-break order; the agent's own pick wins any tie it is part of. */
export const SANDBOX_DOMAIN_PRECEDENCE: readonly SandboxDomain[] = [
  "engineering",
  "legal-compliance",
  "stem",
  "business",
  "humanities",
  "client-production",
  "standard",
];

export const SANDBOX_DOMAIN_KEYWORD_TABLE: Record<SandboxDomain, readonly string[]> = {
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

/** Validates the agent's domain against the expanded taxonomy's keyword evidence. */
export const validateSandboxDomainClassification = (params: {
  agentDomain: SandboxDomain;
  requestText: string;
}): DomainClassification<SandboxDomain> => {
  const agentDomain = SandboxDomainSchema.parse(params.agentDomain);
  return classifyDomainByKeywords({
    agentDomain,
    requestText: params.requestText,
    precedence: SANDBOX_DOMAIN_PRECEDENCE,
    table: SANDBOX_DOMAIN_KEYWORD_TABLE,
  });
};

/**
 * Exact changes required to promote the expanded taxonomy into production. Not
 * executed here; it is the checklist for the Phase-6 promotion change, which must
 * carry the same-change governing-document updates.
 */
export const DOMAIN_TAXONOMY_PROMOTION_PLAN: readonly string[] = [
  "Extend DomainSchema in packages/contracts/src/index.ts with: stem, humanities, legal-compliance, business.",
  "Add a migration for the run_domain pgEnum in packages/db covering the new values.",
  "Extend the M1 intake prompt's domain list and keep medical/health mapped to standard.",
  "Update docs/benchmarkstofocus.md Domain policy and the routing regression set.",
  "Update docs/video-generation-process.md §2 (M1 domain classification).",
  "Do not add a medical/health domain; medical topics stay standard by policy.",
];
