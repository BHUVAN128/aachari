import { ProviderError, resolveFallbackRoute } from "@upcraft/providers";
import type { ModelRoute } from "@upcraft/contracts";

/**
 * Runs a provider call with at most one bounded fallback. A declared fallback
 * route addresses a classified transient failure only; the failed attempt is
 * recorded against the route that failed and the fallback runs as a new
 * recorded attempt. The caller still validates the artifact identically, so
 * quality is never silently downgraded.
 */
export const withFallback = async <T>(
  route: ModelRoute,
  attempt: (route: ModelRoute) => Promise<T>,
  recordFailure: (failedRoute: ModelRoute, error: ProviderError) => Promise<void>,
): Promise<{ value: T; route: ModelRoute }> => {
  try {
    return { value: await attempt(route), route };
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.retryable) throw error;
    const fallback = resolveFallbackRoute(route.capability);
    if (!fallback) throw error;
    await recordFailure(route, error);
    return { value: await attempt(fallback), route: fallback };
  }
};