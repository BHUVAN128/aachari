/**
 * @upcraft/pipeline/pipeline
 *
 * The video-generation pipeline grouped by governing stage. Public surface:
 *   - `processPipelineStage` (executor)
 *   - `stageHandlers` / `stageInputRoles` (dependency graph)
 *   - `getStageInputHash`
 *   - `resolveStageRoute` (re-exported for consumers)
 */
export { processPipelineStage } from "./executor.ts";
export { stageHandlers, stageInputRoles } from "./registry.ts";
export { getStageInputHash } from "./input-hash.ts";
export { resolveStageRoute, stageRoute } from "../routing.ts";
export * from "./retry-policy.ts";
export type { StageContext, StageHandler } from "./context.ts";
export { sceneDiagramArea } from "./scene-area.ts";