import type { BlueprintQaIssue } from "./pacing-guard.ts";

/**
 * s04 sandbox — visual-beat validation and language directive (Flaw 4 + Flaw 6),
 * test-local until Phase-6 promotion.
 *
 * The blueprint contract only requires `visualBeat: string.min(1)`, so "ok" or an
 * untranslated sentence that happened to be copied from the source passes schema
 * validation. These checks make a vague, non-directive, or non-English beat a
 * deterministic finding. Localization is enforced primarily by the prompt rule
 * below; the script heuristic only catches non-Latin targets (a Latin-script
 * target such as Spanish or German is documented as a known limitation).
 */

export const MIN_VISUAL_BEAT_CHARS = 20;
export const MIN_VISUAL_BEAT_WORDS = 4;
export const MAX_VISUAL_BEAT_CHARS = 400;

/**
 * Visual-direction vocabulary. A visual beat must contain at least one word that
 * tells the renderer what changes on the canvas, so a purely descriptive sentence
 * is rejected instead of silently becoming a static slide.
 */
export const VISUAL_DIRECTION_KEYWORDS = [
  "reveal", "draw", "animate", "zoom", "highlight", "pan", "build", "assemble",
  "trace", "label", "show", "display", "illustrate", "map", "compare", "split",
  "explode", "rotate", "transition", "overlay", "underline", "circle", "arrow",
  "graph", "chart", "diagram", "morph", "fade", "focus", "frame", "sequence",
  "sketch", "outline", "magnify", "point", "connect", "stack", "layer", "timeline",
  "walk", "step", "spin", "tilt", "slide", "mark", "annotate", "model", "cut",
  "grow", "shrink", "pulse", "glide",
] as const;

const KEYWORD_PATTERN = new RegExp(`\\b(${VISUAL_DIRECTION_KEYWORDS.join("|")})\\b`, "i");

/**
 * Non-Latin script detection for the localization heuristic. Greek is deliberately
 * excluded so legitimate scientific beats (for example "label the β-carbon") are
 * not false positives.
 */
const NON_LATIN_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

/**
 * Prompt rule the promotion must carry verbatim: the learner-facing prose
 * (purpose, hook, recap, objective) is written in the target language, but the
 * visual beat is an internal renderer instruction and is always English.
 */
export const VISUAL_BEAT_PROMPT_RULES = [
  "Write objective, hook, recap, and every scene purpose in the learner's target language.",
  "Write every visualBeat strictly in English, regardless of the target language; it is an internal renderer instruction, never learner-facing text.",
  "Start each visualBeat with a visual-direction verb and name the canvas change (for example \"Reveal the leaf cross-section, then trace light energy into the chloroplast\").",
  "Keep a visualBeat to one teachable idea; do not embed narration or translated prose in it.",
].join(" ");

export const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

export const isNonEnglishScript = (value: string): boolean => NON_LATIN_SCRIPT.test(value);

export const hasVisualDirectionKeyword = (value: string): boolean => KEYWORD_PATTERN.test(value);

/**
 * Deterministic gate for one visual beat. Precedence: a non-Latin script is
 * reported as `localized` first, then too-short beats as `vague`, then beats with
 * no canvas-direction word as `nonDirective`.
 */
export const validateVisualBeat = (visualBeat: string): BlueprintQaIssue[] => {
  if (isNonEnglishScript(visualBeat)) {
    return [{
      rule: "blueprint-visual-beat-localized",
      evidence: { visualBeat, detectedScript: "non-latin" },
      remediation: "Rewrite the visualBeat in English; only objective, hook, recap, purpose, and narration use the target language.",
    }];
  }

  const chars = visualBeat.trim().length;
  const words = countWords(visualBeat);
  if (chars < MIN_VISUAL_BEAT_CHARS || words < MIN_VISUAL_BEAT_WORDS) {
    return [{
      rule: "blueprint-visual-beat-vague",
      evidence: { visualBeat, chars, words, minChars: MIN_VISUAL_BEAT_CHARS, minWords: MIN_VISUAL_BEAT_WORDS },
      remediation: `Describe the canvas change in at least ${MIN_VISUAL_BEAT_WORDS} words and ${MIN_VISUAL_BEAT_CHARS} characters.`,
    }];
  }

  if (!hasVisualDirectionKeyword(visualBeat)) {
    return [{
      rule: "blueprint-visual-beat-nonDirective",
      evidence: { visualBeat, keywords: [...VISUAL_DIRECTION_KEYWORDS] },
      remediation: "Include a visual-direction word (for example reveal, draw, trace, label, compare) so the renderer knows what changes on the canvas.",
    }];
  }

  return [];
};

/** Applies the single-beat gate to every scene in a blueprint. */
export const validateVisualBeats = (params: { scenes: Array<{ id: string; visualBeat: string }> }): BlueprintQaIssue[] =>
  params.scenes.flatMap((scene) => validateVisualBeat(scene.visualBeat).map((issue) => ({ ...issue, evidence: { ...issue.evidence, sceneId: scene.id } })));
