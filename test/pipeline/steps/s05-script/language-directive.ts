import type { BlueprintQaIssue } from "../s04-blueprint/pacing-guard.ts";

/**
 * W3 — English `visualAction` directive + s06 entity-description language gate
 * (test-local first; promoted into `prompts/script.ts`, the s05/s06 handlers, and
 * the deterministic QA layer at Phase 6).
 *
 * Unlike s04's blueprint prompt (which mandates "Write every visualBeat strictly
 * in English"), the s05 script prompt has no language carve-out for `visualAction`
 * — it embeds `Language: ${run.snapshot.language}` and says nothing else. A Tamil
 * run can therefore emit a Tamil visualAction, which silently breaks three things:
 *   1. `pauseForVisualAction` (pacing.ts) matches English regexes, so the dwell
 *      budget quietly falls back to 0;
 *   2. `s07-assets` includes `line.visualAction` in `lockedTexts`, polluting the
 *      deterministic diagram-label vocabulary and diagram QA;
 *   3. `s11-manifest` copies it into the manifest scene's `visualBeat`, leaving the
 *      renderer instruction language uncontrolled.
 *
 * The same leak exists for s06 `persistentEntities[].description`, which feeds
 * image prompts through `buildSceneAssetBrief`. This module makes a non-English or
 * non-directive visualAction (and a non-English entity description) a zero-token
 * finding, wired into a bounded repair loop that rewrites only the offending
 * fields and keeps the narration verbatim.
 */

export const MAX_LANGUAGE_DIRECTIVE_ATTEMPTS = 3;
export const SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED = "SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED";

export const VISUAL_ACTION_CORRECTION_CONTRACT =
  "Keep the same schema and ids; preserve every narration text verbatim; rewrite only the listed lines' visualAction (and any listed entity description) in English.";

/**
 * Renderer-direction verbs. Includes the `pauseForVisualAction` families
 * (inspect/read/trace/compare/examine and reveal/build/assemble/draw/map) so a
 * passing visualAction always earns its dwell budget.
 */
export const VISUAL_ACTION_DIRECTION_KEYWORDS = [
  "reveal", "inspect", "read", "trace", "compare", "examine", "build", "assemble",
  "draw", "map", "animate", "zoom", "highlight", "pan", "label", "show", "display",
  "illustrate", "split", "explode", "rotate", "transition", "overlay", "underline",
  "circle", "arrow", "graph", "chart", "diagram", "morph", "fade", "focus", "frame",
  "sequence", "sketch", "outline", "magnify", "point", "connect", "stack", "layer",
  "timeline", "walk", "step", "spin", "tilt", "slide", "mark", "annotate", "model",
  "cut", "grow", "shrink", "pulse", "glide",
] as const;

const DIRECTION_PATTERN = new RegExp(`^(${VISUAL_ACTION_DIRECTION_KEYWORDS.join("|")})\\b`, "i");

/**
 * Non-Latin script detection. Greek is deliberately excluded (scientific beats
 * such as "label the β-carbon" are legitimate English renderer instructions).
 */
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

export const isNonEnglishScript = (value: string): boolean => NON_LATIN_SCRIPT.test(value);
export const startsWithDirectionVerb = (value: string): boolean => DIRECTION_PATTERN.test(value.trim());

/**
 * Prompt rule the promotion must carry verbatim. Mirrors `blueprintPromptRules`
 * and adds the explicit narration-language carve-out whose absence caused Finding 3.
 */
export const VISUAL_ACTION_PROMPT_RULES = [
  "Write every narration line in the learner's target language.",
  "Write every visualAction strictly in English, regardless of the target language; it is an internal renderer instruction, never learner-facing text.",
  "Start each visualAction with a visual-direction verb and name the canvas change (for example \"Reveal the leaf cross-section, then trace light energy into the chloroplast\").",
  "Write every persistent entity description in English for the same reason.",
].join(" ");

export type ScriptLike = { narration: Array<{ id: string; text: string; visualAction: string }> };
export type EntityLike = { persistentEntities?: Array<{ id: string; description: string }> };

/** Gate one visualAction: non-Latin first, then a missing leading direction verb. */
export const validateVisualActionLanguage = (visualAction: string): BlueprintQaIssue[] => {
  if (isNonEnglishScript(visualAction)) {
    return [{ rule: "script-visual-action-localized", evidence: { visualAction, detectedScript: "non-latin" }, remediation: "Rewrite the visualAction in English; only narration uses the target language." }];
  }
  if (!startsWithDirectionVerb(visualAction)) {
    return [{ rule: "script-visual-action-non-directive", evidence: { visualAction, keywords: [...VISUAL_ACTION_DIRECTION_KEYWORDS] }, remediation: "Start the visualAction with a visual-direction verb such as reveal, trace, or inspect." }];
  }
  return [];
};

/** Gate a s06 persistent-entity description, which feeds the image prompt. */
export const validateEntityDescriptionLanguage = (entity: { id: string; description: string }): BlueprintQaIssue[] => {
  if (isNonEnglishScript(entity.description)) {
    return [{ rule: "bible-entity-description-localized", evidence: { entityId: entity.id, description: entity.description }, remediation: "Rewrite the persistent entity description in English; it becomes part of the image prompt." }];
  }
  return [];
};

/** Applies the visualAction gate to every line, keyed by line id. */
export const validateVisualActions = (script: ScriptLike): BlueprintQaIssue[] =>
  script.narration.flatMap((line) => validateVisualActionLanguage(line.visualAction).map((issue) => ({ ...issue, evidence: { ...issue.evidence, lineId: line.id } })));

const narrationChanged = (baseline: Map<string, string>, script: ScriptLike): string[] =>
  script.narration.filter((line) => baseline.get(line.id) !== undefined && baseline.get(line.id) !== line.text).map((line) => line.id);

/**
 * The full zero-token pre-check for s05, extended with an optional baseline: a
 * repair must never silently rewrite narration, so a changed line is an issue too.
 */
export const validateScriptLanguageDirective = (script: ScriptLike, baselineNarration?: Map<string, string>): BlueprintQaIssue[] => {
  const issues = validateVisualActions(script);
  if (baselineNarration) {
    const mutated = narrationChanged(baselineNarration, script);
    if (mutated.length) issues.push({ rule: "script-narration-mutated", evidence: { lineIds: mutated }, remediation: "Rewrite only visualAction; narration must stay verbatim during a language repair." });
  }
  return issues;
};

export type LanguageCorrection = { attempt: number; lineIds: string[]; rationale: string; contract: string };
export type LanguageAttempt<T> = { attempt: number; outcome: "completed" | "rejected-by-language-directive"; issues: BlueprintQaIssue[]; value?: T };

export class ScriptLanguageDirectiveExhaustedError extends Error {
  public readonly code = SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED;
  public readonly attempts: LanguageAttempt<unknown>[];
  public constructor(attempts: LanguageAttempt<unknown>[]) {
    super(`${SCRIPT_LANGUAGE_DIRECTIVE_EXHAUSTED}: visualAction language still failed after ${attempts.length} attempt(s)`);
    this.name = "ScriptLanguageDirectiveExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Bounded generate → language-gate loop. On a finding it re-runs only the script
 * generator with the exact line ids and rationale. Narration from the first
 * attempt becomes the baseline, so a repair that mutates narration is rejected and
 * cannot slip through. Exhaustion is a typed, visible terminal failure.
 */
export const runBoundedVisualActionLanguageLoop = async <T extends ScriptLike>(params: {
  generate: (correction: LanguageCorrection | null) => Promise<T>;
  maxAttempts?: number;
  onAttempt?: (attempt: LanguageAttempt<T>) => void;
}): Promise<{ value: T; attempts: LanguageAttempt<T>[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_LANGUAGE_DIRECTIVE_ATTEMPTS;
  const attempts: LanguageAttempt<T>[] = [];
  let correction: LanguageCorrection | null = null;
  let baseline: Map<string, string> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await params.generate(correction);
    baseline ??= new Map(generated.narration.map((line) => [line.id, line.text]));
    const issues = validateScriptLanguageDirective(generated, baseline);
    if (!issues.length) {
      const record: LanguageAttempt<T> = { attempt, outcome: "completed", issues: [], value: generated };
      attempts.push(record);
      params.onAttempt?.(record);
      return { value: generated, attempts };
    }
    const record: LanguageAttempt<T> = { attempt, outcome: "rejected-by-language-directive", issues };
    attempts.push(record);
    params.onAttempt?.(record);
    correction = { attempt: attempt + 1, lineIds: [...new Set(issues.flatMap((issue) => (typeof issue.evidence.lineId === "string" ? [issue.evidence.lineId] : [])))], rationale: issues.map((issue) => issue.rule).join(", "), contract: VISUAL_ACTION_CORRECTION_CONTRACT };
  }
  throw new ScriptLanguageDirectiveExhaustedError(attempts as LanguageAttempt<unknown>[]);
};
