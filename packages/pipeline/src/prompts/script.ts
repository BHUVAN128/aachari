/**
 * Provider structured-output contract for `approved-script/v2`.
 * Pure extraction from `stages.ts`; the object body is byte-identical.
 */
export const scriptJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["approved-script/v2"] }, narration: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, sceneId: { type: "string" }, text: { type: "string" }, claimIds: { type: "array", items: { type: "string" } }, visualAction: { type: "string" } }, required: ["id", "sceneId", "text", "claimIds", "visualAction"] } } }, required: ["schemaVersion", "narration"] } as Record<string, unknown>;