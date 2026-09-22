import { z } from "zod";
import { SandboxIntakeBriefSchema, clampDurationSeconds, INTAKE_DEFAULTS, type SandboxIntakeBrief } from "./defaults.ts";

/**
 * Intake hardening — topic complexity assessment + derived duration (Point 3).
 *
 * Today every terse request freezes at a flat duration and nothing distinguishes
 * "basic addition" from "multi-agent zero-trust architectures"; s05's pacing check
 * can only flag overcrowding after the script is written. This adds a bounded
 * complexity score to the M1 extraction and derives a duration tier from it when
 * the user did not hardcode one.
 *
 * Sandbox-first: this changes the M1 typed artifact contract, so the real
 * `intake-brief/v2` → `intake-brief/v3` version bump and the
 * `video-generation-process.md` §2 / `benchmarkstofocus.md` updates land together
 * at Phase-6 promotion. Downstream `s05` pacing is already parameterized purely by
 * `durationSeconds`, so no stage handler changes.
 */

export const MIN_COMPLEXITY = 1;
export const MAX_COMPLEXITY = 5;

/** Duration tier per complexity band; clamped to the frozen 15–900s range. */
export const COMPLEXITY_DURATION_TIERS: Record<number, number> = {
  1: 60,
  2: 90,
  3: 120,
  4: 180,
  5: 300,
};

export const clampComplexity = (value: number) => Math.min(MAX_COMPLEXITY, Math.max(MIN_COMPLEXITY, Math.round(value)));

/**
 * Sandbox extension of the nullable intake brief with the complexity extraction
 * and an explicit `durationProvided` flag so code can tell a user-stated duration
 * from one the agent filled in.
 */
export const SandboxIntakeBriefV3Schema = SandboxIntakeBriefSchema.extend({
  computedComplexity: z.number().int().min(MIN_COMPLEXITY).max(MAX_COMPLEXITY).nullable(),
  durationProvided: z.boolean(),
});
export type SandboxIntakeBriefV3 = z.infer<typeof SandboxIntakeBriefV3Schema>;

/**
 * Resolves the frozen duration. A user-provided duration always wins; otherwise
 * the complexity tier is used when the model assessed one; otherwise the single
 * code default applies. Every branch is clamped into the snapshot range.
 */
export const deriveDurationSeconds = (params: { provided: number | null; complexity: number | null; fallbackSeconds?: number }): number => {
  if (params.provided !== null) return clampDurationSeconds(params.provided);
  if (params.complexity !== null) return clampDurationSeconds(COMPLEXITY_DURATION_TIERS[clampComplexity(params.complexity)]!);
  return clampDurationSeconds(params.fallbackSeconds ?? INTAKE_DEFAULTS.durationSeconds);
};

/** Parses an explicit duration expression from free text ("10 minutes" → 600). */
export const extractDurationHint = (requestText: string): number | null => {
  const match = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(requestText);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("h") ? 3_600 : unit.startsWith("s") ? 1 : 60;
  return clampDurationSeconds(amount * multiplier);
};

/**
 * Deterministic stand-in for the model's complexity assessment, used by the
 * sandbox when the production prompt does not yet extract one. Word count,
 * technical-term density, and clause count map to a bounded band.
 */
export const estimateComplexity = (requestText: string): number => {
  const words = requestText.trim().split(/\s+/).filter(Boolean).length;
  const technical = (requestText.match(/\b(quantum|thermodynamic|algorithm|derivative|integral|molecular|multi-agent|zero-trust|architecture|mechanism|pathway|enzyme)\b/gi) ?? []).length;
  const clauses = (requestText.match(/,|;|\band\b/gi) ?? []).length;
  const raw = 1 + Math.floor(words / 25) + Math.min(2, technical) + (clauses >= 3 ? 1 : 0);
  return clampComplexity(raw);
};

/** Applies the derived duration onto a v3 sandbox brief. */
export const withDerivedDuration = (brief: SandboxIntakeBriefV3): SandboxIntakeBriefV3 & { durationSeconds: number } => ({
  ...brief,
  durationSeconds: deriveDurationSeconds({ provided: brief.durationProvided ? brief.durationSeconds : null, complexity: brief.computedComplexity }),
});

/** Builds a v3 sandbox brief from a v2 brief plus an assessed complexity. */
export const toSandboxBriefV3 = (brief: SandboxIntakeBrief, complexity: number | null, durationProvided: boolean): SandboxIntakeBriefV3 =>
  SandboxIntakeBriefV3Schema.parse({ ...brief, schemaVersion: "intake-brief/v2", computedComplexity: complexity, durationProvided });
