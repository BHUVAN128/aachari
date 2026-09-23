/**
 * Provider structured-output contract for `lesson-blueprint/v2`.
 * Pure extraction from `stages.ts`; the object body is byte-identical.
 */
export const blueprintJsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", enum: ["lesson-blueprint/v2"] }, objective: { type: "string" }, prerequisites: { type: "array", minItems: 1, items: { type: "string" } }, hook: { type: "string" }, recap: { type: "string" }, knowledgeCheck: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } }, answerIndex: { type: "integer", minimum: 0 } }, required: ["question", "options", "answerIndex"] }, scenes: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, order: { type: "integer" }, purpose: { type: "string" }, claimIds: { type: "array", minItems: 1, items: { type: "string" } }, visualBeat: { type: "string" } }, required: ["id", "order", "purpose", "claimIds", "visualBeat"] } } }, required: ["schemaVersion", "objective", "prerequisites", "hook", "recap", "scenes"] } as Record<string, unknown>;

/**
 * Blueprint prompt version rules (`lesson_blueprint/v3`). They encode the §4
 * gates the deterministic QA enforces: the learner-facing prose is written in the
 * target language while the visual beat is a strictly English renderer
 * instruction, and the scene count/claim load must fit the requested duration.
 */
export const blueprintPromptRules = [
  "Write objective, hook, recap, and every scene purpose in the learner's target language.",
  "Write every visualBeat strictly in English, regardless of the target language; it is an internal renderer instruction, never learner-facing text.",
  "Start each visualBeat with a visual-direction verb and name the canvas change (for example \"Reveal the leaf cross-section, then trace light energy into the chloroplast\").",
  "Keep a visualBeat to one teachable idea; do not embed narration or translated prose in it.",
  "Keep each scene between 6 and 20 seconds and at most 3 cited claims so the scene count matches the duration budget.",
].join(" ");
