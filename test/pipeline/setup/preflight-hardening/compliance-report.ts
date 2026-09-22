import { z } from "zod";
import type { SourcesScreening } from "./screening.ts";
import type { PrivacyGateDecision, PrivacyScan } from "./privacy.ts";
import type { ProvenanceValidation } from "./provenance.ts";
import type { CostCeiling, RunIdentityAssertion } from "./fraud-controls.ts";

/**
 * s01 Preflight hardening — typed compliance evidence (risk R1–R5).
 *
 * One versioned, reproducible artifact records what s01 screened, what it
 * decided, and why, using only category names, counts, and hashes. It is the
 * evidence trail a release record can cite without duplicating private source
 * text, and its contract is validated by the existing harness contract grammar.
 */

export const COMPLIANCE_REPORT_SCHEMA_VERSION = "compliance-report/v1";

/** Terminal preflight failure codes. None of these is ever retried. */
export const COMPLIANCE_FAILURE_CODES = ["safety_policy_rejected", "safety_review_required", "privacy_blocked", "provenance_incomplete", "duplicate_run"] as const;
export type ComplianceFailureCode = (typeof COMPLIANCE_FAILURE_CODES)[number];

export const SourceScreeningRecordSchema = z.object({
  sourceId: z.string().min(1),
  contentHash: z.string().nullable(),
  screenedChars: z.number().int().nonnegative(),
  screenedBy: z.enum(["denylist", "model"]),
  verdict: z.enum(["pass", "blocked"]),
  categories: z.array(z.string()),
  failureCode: z.string().nullable(),
});

export const PrivacyFindingSchema = z.object({
  kind: z.string().min(1),
  count: z.number().int().positive(),
  sampleHash: z.string().min(1).nullable(),
});

export const PrivacyRecordSchema = z.object({
  allowed: z.boolean(),
  failureCode: z.string().nullable(),
  blockingKinds: z.array(z.string()),
  findings: z.array(PrivacyFindingSchema),
});

export const ProvenanceRecordSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.string(),
  nameHash: z.string(),
  contentHash: z.string().nullable(),
  origin: z.string().nullable(),
  originStatus: z.enum(["https", "http-insecure", "not-http", "not-applicable"]),
  rightsDeclaration: z.enum(["unrecorded", "declared"]),
});

export const RouteCostCeilingSchema = z.object({
  capability: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  inputCharacters: z.number().int().nonnegative().nullable(),
  costMicrounits: z.number().int().nonnegative().nullable(),
  unpriced: z.boolean(),
});

export const CostCeilingSchema = z.object({
  pricingVersion: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  sourceCount: z.number().int().nonnegative(),
  totalMicrounits: z.number().int().nonnegative().nullable(),
  unpriced: z.boolean(),
  routes: z.array(RouteCostCeilingSchema).min(1),
});

export const IdempotencySchema = z.object({
  identityKey: z.string().min(1),
  duplicateRunId: z.string().nullable(),
  unique: z.boolean(),
});

export const ComplianceReportSchema = z.object({
  schemaVersion: z.literal(COMPLIANCE_REPORT_SCHEMA_VERSION),
  checkedAt: z.string().min(1),
  snapshotHash: z.string().min(1),
  decision: z.enum(["pass", "blocked"]),
  failureCode: z.enum(COMPLIANCE_FAILURE_CODES).nullable(),
  sourceCount: z.number().int().nonnegative(),
  screening: z.array(SourceScreeningRecordSchema),
  privacy: PrivacyRecordSchema,
  provenance: z.array(ProvenanceRecordSchema),
  costCeiling: CostCeilingSchema,
  idempotency: IdempotencySchema,
});
export type ComplianceReport = z.infer<typeof ComplianceReportSchema>;

export type ComplianceDecision = { decision: "pass" | "blocked"; failureCode: ComplianceFailureCode | null };

/**
 * Ordered gate. Any single blocked check is a terminal decision that must never
 * be retried and must prevent s02 from scheduling a billable call. Screening is
 * evaluated first because it is the only check that can stop harmful content
 * before it is even parsed for PII or provenance.
 */
export const decideComplianceGate = (params: {
  screening: SourcesScreening;
  privacy: PrivacyGateDecision;
  provenance: ProvenanceValidation;
  idempotency: RunIdentityAssertion;
}): ComplianceDecision => {
  if (params.screening.blocked) return { decision: "blocked", failureCode: params.screening.failureCode ?? "safety_policy_rejected" };
  if (!params.privacy.allowed) return { decision: "blocked", failureCode: "privacy_blocked" };
  if (!params.provenance.complete) return { decision: "blocked", failureCode: "provenance_incomplete" };
  if (!params.idempotency.unique) return { decision: "blocked", failureCode: "duplicate_run" };
  return { decision: "pass", failureCode: null };
};

/** Assembles and schema-validates the compliance report; unknown fields are dropped. */
export const buildComplianceReport = (params: {
  checkedAt?: string;
  snapshotHash: string;
  sourceCount: number;
  screening: SourcesScreening;
  privacyScan: PrivacyScan;
  privacy: PrivacyGateDecision;
  provenance: ProvenanceValidation;
  costCeiling: CostCeiling;
  idempotency: RunIdentityAssertion;
}): ComplianceReport => {
  const gate = decideComplianceGate({ screening: params.screening, privacy: params.privacy, provenance: params.provenance, idempotency: params.idempotency });
  return ComplianceReportSchema.parse({
    schemaVersion: COMPLIANCE_REPORT_SCHEMA_VERSION,
    checkedAt: params.checkedAt ?? new Date().toISOString(),
    snapshotHash: params.snapshotHash,
    decision: gate.decision,
    failureCode: gate.failureCode,
    sourceCount: params.sourceCount,
    screening: params.screening.records,
    privacy: {
      allowed: params.privacy.allowed,
      failureCode: params.privacy.failureCode,
      blockingKinds: params.privacy.blockingKinds,
      findings: params.privacyScan.findings,
    },
    provenance: params.provenance.records,
    costCeiling: params.costCeiling,
    idempotency: params.idempotency,
  });
};
