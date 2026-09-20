import { z } from "zod";
import { ApprovedScriptSchema } from "@upcraft/contracts";

/**
 * Gap 2 — visual pacing (test-local first; promoted at Phase 6).
 *
 * The approved script has no way to ask for a pause while a diagram is inspected,
 * so TTS reads the whole narration at one rhythm and the visual beat cannot dwell.
 * This module adds a typed `pauseMs` to each narration line and defines the
 * duration budget the voiceover stage must satisfy:
 *
 *   measuredAudioDurationMs >= sum(spokenWordDurations) + sum(pauseMs)
 *
 * `pauseMs` is proportional to the visual beat's dwell need and 0 for plain
 * lines. Promotion moves the field into `packages/contracts` `ScriptLineSchema`,
 * into `prompts/script.ts`, and into `video-generation-process.md` §5/§9.
 */

export const MAX_PAUSE_MS = 4_000;
export const MAX_TOTAL_PAUSE_RATIO = 0.35;
export const MIN_SPEECH_MS_PER_WORD = 180;

/** Test-local extension of `approved-script/v2` with a typed pause per line. */
export const PacedScriptLineSchema = z.object({
  id: z.string().uuid(),
  sceneId: z.string().uuid(),
  text: z.string().min(1),
  claimIds: z.array(z.string().uuid()),
  visualAction: z.string().min(1),
  pauseMs: z.number().int().min(0).max(MAX_PAUSE_MS).default(0),
});
export const PacedApprovedScriptSchema = ApprovedScriptSchema.extend({
  narration: z.array(PacedScriptLineSchema).min(1),
});
export type PacedApprovedScript = z.infer<typeof PacedApprovedScriptSchema>;

/** Dwell need per visual beat keyword; deterministic and model-independent. */
export const pauseForVisualAction = (visualAction: string): number => {
  const normalized = visualAction.toLowerCase();
  if (/inspect|read the label|trace|compare|examine/.test(normalized)) return 2_000;
  if (/reveal|build|assemble|draw|map/.test(normalized)) return 1_000;
  return 0;
};

export const sumPauses = (script: PacedApprovedScript) => script.narration.reduce((sum, line) => sum + line.pauseMs, 0);

/** Estimated spoken duration from the canonical narration; a conservative floor. */
export const estimatedSpeechMs = (script: PacedApprovedScript, msPerWord = MIN_SPEECH_MS_PER_WORD) => script.narration.reduce((sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length * msPerWord, 0);

export type PacingIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

/**
 * Validates the pacing budget: pauses must be bounded, and the total pause budget
 * must not crowd out speech beyond the allowed ratio of the requested duration.
 */
export const validatePacing = (params: { script: PacedApprovedScript; durationSeconds: number }): PacingIssue[] => {
  const issues: PacingIssue[] = [];
  const durationMs = params.durationSeconds * 1_000;
  for (const line of params.script.narration) {
    if (line.pauseMs < 0 || line.pauseMs > MAX_PAUSE_MS) {
      issues.push({ rule: "script-pause-out-of-range", evidence: { lineId: line.id, pauseMs: line.pauseMs, max: MAX_PAUSE_MS }, remediation: "Clamp the pause to the allowed per-line budget." });
    }
  }
  const pauses = sumPauses(params.script);
  const speech = estimatedSpeechMs(params.script);
  if (pauses > durationMs * MAX_TOTAL_PAUSE_RATIO) {
    issues.push({ rule: "script-pause-budget", evidence: { pauses, durationMs, ratio: MAX_TOTAL_PAUSE_RATIO }, remediation: "Reduce pauses so speech still dominates the requested duration." });
  }
  if (speech + pauses > durationMs * 1.4) {
    issues.push({ rule: "script-duration-overrun", evidence: { speech, pauses, durationMs }, remediation: "Shorten narration or reduce pauses to fit the requested duration." });
  }
  return issues;
};

/**
 * The voiceover gate: measured audio must cover speech plus every pause. A short
 * render means a pause was dropped or the narration was truncated.
 */
export const validatePacedAudio = (params: { script: PacedApprovedScript; measuredDurationMs: number; toleranceMs?: number }): PacingIssue[] => {
  const required = estimatedSpeechMs(params.script) + sumPauses(params.script);
  const tolerance = params.toleranceMs ?? Math.max(400, Math.round(required * 0.05));
  if (params.measuredDurationMs + tolerance < required) {
    return [{ rule: "voice-pacing-underflow", evidence: { measuredDurationMs: params.measuredDurationMs, requiredMs: required, tolerance }, remediation: "Re-synthesize with the line-structured narration so every reserved pause is rendered." }];
  }
  return [];
};