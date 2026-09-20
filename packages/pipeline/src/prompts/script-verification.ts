/**
 * Provider structured-output contract for `script-verification/v2`.
 * Pure extraction from `stages.ts`; the object body is byte-identical.
 */
export const scriptVerificationJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["script-verification/v2"] }, evidence: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { lineId: { type: "string" }, supported: { type: "boolean" }, unsupportedClaimIds: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["lineId", "supported", "unsupportedClaimIds", "rationale"] } }, notes: { type: "array", items: { type: "string" } } }, required: ["schemaVersion", "evidence", "notes"] } as Record<string, unknown>;