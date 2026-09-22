import { IntakeBriefV3Schema, type AudienceCategory, type AspectRatio, type ResolvedIntakeBriefV3 } from "@upcraft/contracts";

/**
 * Code-owned intake defaults, complexity→duration derivation, and normalization
 * (Points 1 and 3, promoted).
 *
 * The Intake Briefing Agent now emits `intake-brief/v3`, where any configuration
 * value the user did not state is null. This module is the single source of truth
 * for the defaults and for turning a bounded complexity assessment into a
 * duration, so the frozen `input-snapshot/v1` every downstream stage receives is
 * always complete and no stage handler changes.
 */

export const INTAKE_DEFAULTS = {
  learningLevel: "Grade 8",
  audienceCategory: "school",
  durationSeconds: 60,
  aspectRatio: "16:9",
  visualProfile: "Precise, calm educational motion graphics",
  requestedDestination: "local",
} as const satisfies {
  learningLevel: string;
  audienceCategory: AudienceCategory;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  visualProfile: string;
  requestedDestination: string;
};

export const MIN_DURATION_SECONDS = 15;
export const MAX_DURATION_SECONDS = 900;
export const MIN_COMPLEXITY = 1;
export const MAX_COMPLEXITY = 5;

/** Duration tier per complexity band; clamped to the frozen 15–900s range. */
export const COMPLEXITY_DURATION_TIERS: Record<number, number> = { 1: 60, 2: 90, 3: 120, 4: 180, 5: 300 };

export const clampDurationSeconds = (value: number) => Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.round(value)));
export const clampComplexity = (value: number) => Math.min(MAX_COMPLEXITY, Math.max(MIN_COMPLEXITY, Math.round(value)));

/**
 * Resolves the frozen duration: a user-provided duration always wins; otherwise
 * the complexity tier; otherwise the single code default. Always clamped.
 */
export const deriveDurationSeconds = (params: { provided: number | null; complexity: number | null; fallbackSeconds?: number }): number => {
  if (params.provided !== null) return clampDurationSeconds(params.provided);
  if (params.complexity !== null) return clampDurationSeconds(COMPLEXITY_DURATION_TIERS[clampComplexity(params.complexity)]!);
  return clampDurationSeconds(params.fallbackSeconds ?? INTAKE_DEFAULTS.durationSeconds);
};

/** Coalesces a v3 extraction into the complete, frozen configuration. */
export const normalizeIntakeBrief = (extraction: unknown, defaults: typeof INTAKE_DEFAULTS = INTAKE_DEFAULTS): ResolvedIntakeBriefV3 => {
  const parsed = IntakeBriefV3Schema.parse(extraction);
  const pick = <T>(value: T | null, fallback: T): T => value ?? fallback;
  const durationProvided = parsed.durationProvided && parsed.durationSeconds !== null;
  return {
    ...parsed,
    learningLevel: pick(parsed.learningLevel, defaults.learningLevel),
    audienceCategory: pick(parsed.audienceCategory, defaults.audienceCategory),
    durationSeconds: deriveDurationSeconds({
      provided: durationProvided ? parsed.durationSeconds : null,
      complexity: parsed.computedComplexity,
      fallbackSeconds: defaults.durationSeconds,
    }),
    visualProfile: pick(parsed.visualProfile, defaults.visualProfile),
    aspectRatio: pick(parsed.aspectRatio, defaults.aspectRatio),
    requestedDestination: pick(parsed.requestedDestination, defaults.requestedDestination),
  };
};
