import { STAGE_CAPABILITIES, resolveModelRoute } from "@upcraft/providers";
import type { ModelRoute, StageName } from "@upcraft/contracts";

/**
 * Resolves the frozen route for a stage before it starts. `undefined` marks a
 * deterministic stage, which keeps the `deterministic` provenance shape older
 * records already use.
 *
 * Pure extraction from `stages.ts`; behavior is unchanged.
 */
export const resolveStageRoute = (stage: StageName): ModelRoute | undefined => {
  const capability = STAGE_CAPABILITIES[stage];
  return capability ? resolveModelRoute(capability) : undefined;
};

export const stageRoute = resolveStageRoute;

export const deterministicProvenance = { provider: "deterministic", model: "repository-code" };

export const routeProvenance = (route: ModelRoute | undefined) => route
  ? { provider: route.provider, model: route.model, modelRef: route.modelRef, configVersion: route.configVersion, resolvedFrom: route.resolvedFrom }
  : deterministicProvenance;