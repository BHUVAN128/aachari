import { z } from "zod";
import { AspectRatioSchema, AudienceCategorySchema, IntakeBriefV2Schema, type IntakeBriefV2 } from "@upcraft/contracts";

/**
 * Intake hardening — code-owned defaults (Point 1).
 *
 * Today the Intake Briefing Agent prompt is told to invent defaults ("Grade 8",
 * "60 seconds", "16:9") for any field the user omitted. That makes the model the
 * source of truth for configuration and forces a prompt edit to change a default.
 * The governing principle is the opposite: the LLM extracts, code owns policy.
 *
 * The sandbox brief therefore makes every configuration field nullable. A terse
 * request like "photosynthesis working" may legally extract only the topic and
 * language; `normalizeIntakeBrief` coalesces the nulls from the single
 * `INTAKE_DEFAULTS` constant and clamps the duration into the frozen snapshot's
 * 15–900 second range before `input-snapshot/v1` is written. The frozen snapshot
 * stays complete, so no downstream stage changes.
 *
 * Promotion (Phase 6) makes the same fields optional in `IntakeBriefV2Schema`
 * and removes the defaulting instruction from `packages/providers/src/intake.ts`.
 */

/** The single source of truth for omitted intake configuration. */
export const INTAKE_DEFAULTS = {
  learningLevel: "Grade 8",
  audienceCategory: "school",
  durationSeconds: 60,
  aspectRatio: "16:9",
  visualProfile: "Precise, calm educational motion graphics",
  requestedDestination: "local",
} as const satisfies {
  learningLevel: string;
  audienceCategory: z.infer<typeof AudienceCategorySchema>;
  durationSeconds: number;
  aspectRatio: z.infer<typeof AspectRatioSchema>;
  visualProfile: string;
  requestedDestination: string;
};

/** The frozen `input-snapshot/v1` duration bounds. */
export const MIN_DURATION_SECONDS = 15;
export const MAX_DURATION_SECONDS = 900;

/**
 * Sandbox extension of `intake-brief/v2` where every configuration field may be
 * absent (null) because the user did not state it. `topic`, `domain`, and
 * `language` stay required: they are the extraction core, not a preference.
 */
export const SandboxIntakeBriefSchema = IntakeBriefV2Schema.extend({
  learningLevel: z.string().min(2).max(120).nullable(),
  audienceCategory: AudienceCategorySchema.nullable(),
  /** Any positive integer; `normalizeIntakeBrief` clamps into the frozen range. */
  durationSeconds: z.number().int().positive().nullable(),
  visualProfile: z.string().min(2).max(200).nullable(),
  aspectRatio: AspectRatioSchema.nullable(),
  requestedDestination: z.string().min(1).max(200).nullable(),
});
export type SandboxIntakeBrief = z.infer<typeof SandboxIntakeBriefSchema>;

/** Clamps (and rounds) a duration into the frozen snapshot range. */
export const clampDurationSeconds = (value: number) => Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.round(value)));

/** Names the configuration fields that had to be filled from code defaults. */
export const defaultedFields = (brief: SandboxIntakeBrief): Array<keyof typeof INTAKE_DEFAULTS> =>
  (Object.keys(INTAKE_DEFAULTS) as Array<keyof typeof INTAKE_DEFAULTS>).filter((field) => brief[field] === null || brief[field] === undefined);

/**
 * Coalesces a nullable sandbox brief into the complete `intake-brief/v2` the
 * frozen snapshot requires. Pure and deterministic: the same brief always maps
 * to the same frozen configuration, and changing a default is one edit here.
 */
export const normalizeIntakeBrief = (brief: SandboxIntakeBrief, defaults: typeof INTAKE_DEFAULTS = INTAKE_DEFAULTS): IntakeBriefV2 => {
  const parsed = SandboxIntakeBriefSchema.parse(brief);
  const pick = <T>(value: T | null | undefined, fallback: T): T => value ?? fallback;
  return IntakeBriefV2Schema.parse({
    schemaVersion: "intake-brief/v2",
    topic: parsed.topic,
    learningLevel: pick(parsed.learningLevel, defaults.learningLevel),
    domain: parsed.domain,
    audienceCategory: pick(parsed.audienceCategory, defaults.audienceCategory),
    durationSeconds: clampDurationSeconds(pick(parsed.durationSeconds, defaults.durationSeconds)),
    language: parsed.language,
    visualProfile: pick(parsed.visualProfile, defaults.visualProfile),
    aspectRatio: pick(parsed.aspectRatio, defaults.aspectRatio),
    requestedDestination: pick(parsed.requestedDestination, defaults.requestedDestination),
  });
};
