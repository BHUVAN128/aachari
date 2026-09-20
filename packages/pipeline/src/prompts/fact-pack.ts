/**
 * Provider structured-output contract for `fact-pack/v2`.
 *
 * These are transport-level JSON schemas that constrain a provider's
 * structured-output claim. They duplicate the zod contract in
 * `@upcraft/contracts` on purpose: the provider receives a JSON Schema, while
 * the pipeline still parses and validates the returned artifact against the
 * authoritative zod schema. This file is a pure extraction from `stages.ts`;
 * the object body is byte-identical so artifact hashes stay stable.
 */
export const factPackJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["fact-pack/v2"] }, claims: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] }, critical: { type: "boolean" } }, required: ["id", "text", "evidence", "critical"] } }, caveats: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, evidence: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, sourceHash: { type: "string" }, segmentIds: { type: "array", items: { type: "string" } }, locator: { type: "string" } }, required: ["sourceId", "sourceHash", "segmentIds", "locator"] } }, required: ["text"] } } }, required: ["schemaVersion", "claims", "caveats"] } as Record<string, unknown>;