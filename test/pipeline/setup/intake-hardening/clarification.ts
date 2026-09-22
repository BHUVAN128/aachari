import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderUsageSnapshot } from "@upcraft/providers";

/**
 * Intake hardening — intake clarification loop (intake-clarification/v1).
 *
 * `processIntakeSession` sends the raw request straight to the billable briefing
 * call. A keyboard-mash, a pasted fragment, or a one-word answer is either
 * rejected by the schema (`topic` needs 3+ chars) or is confidently mis-read into
 * a wrong frozen topic. This module adds a bounded, stateful clarification loop
 * in front of the briefing call: obvious garbage gets one empathetic question, a
 * genuinely ambiguous request gets model-authored options, and every uncertain
 * case defers to the model instead of a hard gate.
 *
 * Six review points are closed by construction:
 *  1. Resume is not re-evaluated by heuristics (`priorTurns.length > 0` bypasses
 *     them), so an answer like "Option A" is never flagged again.
 *  2. Options are only produced for `ambiguous_request`; the unparseable path
 *     asks a code-written question with `options: []` — no invented topics.
 *  3. A STEM token whitelist plus structural rules replace any dictionary: SQL,
 *     JWT, `C++`, `x`/`y` variables, and equations stay clean.
 *  4. A high symbol ratio is never sufficient on its own to reject.
 *  5. "Degenerate" is never used; the label is `unparseable` and the wording is
 *     empathetic so kids, ESL learners, and STT garble are not hard-rejected.
 *  6. The resume context is transient model input only — never persisted into
 *     `input-snapshot/v1`, telemetry, or an attempt record.
 *
 * Sandbox-first: identical layout to `safety.ts`. Promotion wires the model
 * assessor to a real route in `packages/providers` (reusing the approved
 * `intake-brief` capability — no new model route) and adds the `needs_input`
 * session status to `packages/contracts`.
 */

export const MAX_CLARIFICATION_ROUNDS = 2;

export const CLARIFICATION_AGENT_ID = "intake-clarification-agent";
export const CLARIFICATION_PROMPT_VERSION = "intake-clarification/v1";

export const CLARIFICATION_KINDS = ["unparseable_input", "ambiguous_request"] as const;

export const IntakeClarificationSchema = z.object({
  schemaVersion: z.literal("intake-clarification/v1"),
  kind: z.enum(CLARIFICATION_KINDS),
  question: z.string().min(8).max(500),
  options: z.array(z.string().min(2).max(200)).max(4).default([]),
  round: z.number().int().min(1).max(MAX_CLARIFICATION_ROUNDS),
  signals: z.array(z.string()).default([]),
});
export type IntakeClarification = z.infer<typeof IntakeClarificationSchema>;

export const ClarificationTurnSchema = z.object({
  asked: IntakeClarificationSchema,
  answer: z.string().min(1).max(2_000),
  answeredVia: z.enum(["text", "mic", "option"]),
  at: z.string(),
});
export type ClarificationTurn = z.infer<typeof ClarificationTurnSchema>;

/**
 * Deterministic STEM shapes that would otherwise look like consonant-only garbage.
 * This is deliberately a whitelist, not a dictionary: it only needs to cover the
 * tokens that would embarrass the router in a regression test. Everything the
 * whitelist and structural rules cannot decide defers to the model.
 */
export const STEM_TOKEN_WHITELIST = new Set([
  "sql", "html", "http", "https", "jwt", "api", "css", "js", "ts", "json", "xml", "yaml", "csv",
  "aws", "gcp", "azure", "ocr", "irl", "cli", "sdk", "gpt", "llm", "rag", "vm", "db", "os", "ip",
  "x", "y", "z", "n", "nth", "pi", "mc", "ii", "iii", "iv", "ai", "ml", "nlp", "cnn", "rnn", "lstm",
  "cpu", "gpu", "ram", "dns", "tcp", "udp", "ssh", "tls", "ssl", "dbms", "acid", "rest", "grpc",
]);

/** Canonical keyboard mashes — structural garbage, not a general word list. */
const KEYBOARD_MASH_TOKENS = new Set([
  "asdf", "asdfg", "asdfgh", "qwer", "qwert", "qwerty", "zxcv", "zxcvb", "zxcvbn",
  "wasd", "hjkl", "jkl", "sdfjk", "sdfjkh", "sfdkjh", "dfgh", "fghj", "ghjk",
]);

/** Words whose presence at the end of the text marks a dangling fragment. */
const DANGLING_FUNCTION_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "is", "are", "was", "were", "be",
  "and", "or", "but", "with", "from", "by", "as", "that", "this", "these", "those",
  "for", "about", "into", "over", "under", "between",
]);

const ZERO_WIDTH_AND_CONTROL = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u0000-\u001f\u007f]/g;
const VOWELS = /[aeiouy]/;

export type RequestQuality =
  | { verdict: "clean"; signals: [] }
  | { verdict: "unparseable"; signals: string[] }
  | { verdict: "unsure"; signals: string[] };

const stripEdges = (token: string) => token.replace(/^[^0-9a-z]+|[^0-9a-z]+$/gi, "");

const tokenizeLetters = (text: string): string[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map(stripEdges)
    .filter((token) => /[a-z]/i.test(token));

const isWhitelisted = (token: string) => STEM_TOKEN_WHITELIST.has(token.toLowerCase().replace(/[^a-z]/g, "")) || STEM_TOKEN_WHITELIST.has(token.toLowerCase());

const isRepeatedChar = (token: string) => /^(.)\1+$/u.test(token);

/** Longest run of consecutive consonants (treating y as a vowel). */
const maxConsonantRun = (token: string): number => {
  let longest = 0;
  let current = 0;
  for (const char of token.toLowerCase()) {
    if (/[a-z]/.test(char) && !VOWELS.test(char)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
};

/**
 * A token is suspicious when it is structurally unlikely to be a word: repeated
 * characters, a canonical mash, consonant-only, or carrying a 4+ consonant run.
 * Single-letter tokens are variables, and whitelist hits are STEM by fiat.
 */
const isSuspiciousToken = (token: string): boolean => {
  const lowerToken = token.toLowerCase();
  if (isWhitelisted(lowerToken)) return false;
  if (lowerToken.length === 1) return false;
  if (isRepeatedChar(lowerToken)) return true;
  if (KEYBOARD_MASH_TOKENS.has(lowerToken)) return true;
  if (!VOWELS.test(lowerToken)) return true;
  if (maxConsonantRun(lowerToken) >= 4) return true;
  return false;
};

/**
 * Deterministic request-quality triage. Stateful by design: on resume
 * (`priorTurns.length > 0`) heuristics are skipped entirely and the model judges
 * the answer, so a one-token answer is never double-jeopardized.
 */
export const assessRequestQuality = (text: string, priorTurns: ClarificationTurn[] = []): RequestQuality => {
  if (priorTurns.length > 0) return { verdict: "clean", signals: [] };

  const stripped = text.replace(ZERO_WIDTH_AND_CONTROL, " ");
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return { verdict: "unparseable", signals: ["empty"] };

  const letterTokens = tokenizeLetters(trimmed);
  if (letterTokens.length === 0) {
    return trimmed.length >= 3 ? { verdict: "unparseable", signals: ["no_letters"] } : { verdict: "unsure", signals: ["too_short"] };
  }

  const whitelistHits = letterTokens.filter(isWhitelisted);
  const suspicious = letterTokens.filter(isSuspiciousToken);

  // RULE 2: every letter token looks like garbage and no STEM token rescues it.
  if (whitelistHits.length === 0 && suspicious.length === letterTokens.length) {
    return { verdict: "unparseable", signals: ["keyboard_mash"] };
  }

  // RULE 4a: a dangling function word marks a pasted fragment, not a request.
  const words = stripped
    .split(/\s+/)
    .map(stripEdges)
    .filter(Boolean);
  const lastWord = words.at(-1)?.toLowerCase();
  if (words.length >= 2 && lastWord && DANGLING_FUNCTION_WORDS.has(lastWord)) {
    return { verdict: "unsure", signals: ["dangling_fragment"] };
  }

  // RULE 4b: at least half the tokens look garbled (e.g. STT) but not all —
  // defer to the model rather than hard-rejecting a real learner.
  if (suspicious.length > 0 && suspicious.length * 2 >= letterTokens.length) {
    return { verdict: "unsure", signals: ["garbled_tokens"] };
  }

  // RULE 3: a high symbol ratio is never sufficient alone; with at most one letter
  // token it defers to the model (a real `C++` / equation request stays answerable).
  const symbolCount = (trimmed.match(/[^0-9a-z\s]/gi) ?? []).length;
  if (symbolCount > trimmed.length * 0.5 && letterTokens.length <= 1) {
    return { verdict: "unsure", signals: ["symbol_heavy"] };
  }

  return { verdict: "clean", signals: [] };
};

/** The empathetic, code-written question used when nothing can be parsed. */
export const UNPARSEABLE_QUESTION = "I didn't quite catch that — could you tell me a bit more about what you'd like to learn?";

export const CLARIFICATION_INSTRUCTIONS = `You triage lesson requests for a source-grounded educational video system.
Decide whether the request is an answerable lesson request or needs one clarifying question.
Educational topics, including medical and scientific subjects, are answerable. A terse request like "photosynthesis working" is answerable — never ask about a real topic.
When clarification is needed, complete the user's partial thought into at most 4 short option phrasings of what they might mean; each option must visibly extend the user's own words and stay strictly educational. Never invent unrelated topics, and never include personal details from the request in the options or the question.
Return only the strict structured object.`;

export const ClarificationAssessmentSchema = z.object({
  needsClarification: z.boolean(),
  question: z.string().min(8).max(500).optional(),
  options: z.array(z.string().min(2).max(200)).max(4).optional(),
});

export type ClarificationAssessment =
  | { needsClarification: false }
  | { needsClarification: true; question: string; options: string[] };

/** The model-backed runner, injected so this sandbox does not import the SDK. */
export type ClarificationModelRunner = (params: { modelRef: string; instructions: string; prompt: string }) => Promise<{ output: unknown; usage?: ProviderUsageSnapshot }>;

export type ClarificationAssessorResult = {
  assessment: ClarificationAssessment;
  usage: ProviderUsageSnapshot;
  latencyMs: number;
};

export type ClarificationAssessor = (params: { requestText: string; priorTurns: ClarificationTurn[] }) => Promise<ClarificationAssessorResult> | ClarificationAssessorResult;

/**
 * Builds a model-backed assessor from an injected runner (promotion-ready).
 * Malformed model output throws a `ZodError`; the caller records a failed
 * attempt and never freezes an unvalidated clarification.
 */
export const createModelClarificationAssessor = (run: ClarificationModelRunner, modelRef: string): ClarificationAssessor => {
  return async ({ requestText }) => {
    const started = Date.now();
    const { output, usage } = await run({ modelRef, instructions: CLARIFICATION_INSTRUCTIONS, prompt: `Lesson request:\n${requestText}` });
    const parsed = ClarificationAssessmentSchema.parse(output);
    const assessment: ClarificationAssessment = parsed.needsClarification
      ? { needsClarification: true, question: parsed.question ?? UNPARSEABLE_QUESTION, options: parsed.options ?? [] }
      : { needsClarification: false };
    return { assessment, usage: usage ?? {}, latencyMs: Date.now() - started };
  };
};

export type ClarificationDecision =
  | { action: "proceed" }
  | { action: "ask"; clarification: IntakeClarification }
  | { action: "exhausted" };

export const buildClarification = (params: { kind: IntakeClarification["kind"]; question: string; options: string[]; round: number; signals: string[] }): IntakeClarification =>
  IntakeClarificationSchema.parse({
    schemaVersion: "intake-clarification/v1",
    kind: params.kind,
    question: params.question,
    options: params.options,
    round: params.round,
    signals: params.signals,
  });

/**
 * Central round policy. Terminates at `MAX_CLARIFICATION_ROUNDS`; the unparseable
 * path always uses the code-written empathetic question with no options, and only
 * an `unsure` verdict with a model "clarify" decision produces model options.
 */
export const decideClarification = (params: {
  quality: RequestQuality;
  assessment?: ClarificationAssessment;
  roundsUsed: number;
}): ClarificationDecision => {
  if (params.quality.verdict === "clean") return { action: "proceed" };
  if (params.roundsUsed >= MAX_CLARIFICATION_ROUNDS) return { action: "exhausted" };

  const round = params.roundsUsed + 1;
  if (params.quality.verdict === "unparseable") {
    return {
      action: "ask",
      clarification: buildClarification({
        kind: "unparseable_input",
        question: UNPARSEABLE_QUESTION,
        options: [],
        round,
        signals: params.quality.signals,
      }),
    };
  }

  if (params.assessment?.needsClarification) {
    return {
      action: "ask",
      clarification: buildClarification({
        kind: "ambiguous_request",
        question: params.assessment.question,
        options: params.assessment.options,
        round,
        signals: params.quality.signals,
      }),
    };
  }

  return { action: "proceed" };
};

/**
 * Post-brief backstop: a brief that survived with a garbage topic must not be
 * frozen. Reuses the same structural rules on the extracted topic only; a
 * `scrubbed` result routes back to one final (capped) clarification round.
 */
export const scrubTopicForSnapshot = (topic: string): { topic: string; scrubbed: boolean } => {
  const quality = assessRequestQuality(topic, []);
  return { topic, scrubbed: quality.verdict === "unparseable" };
};

/** Hashes transient model input so a manifest can prove what was seen without storing it. */
export const hashTransientInput = (value: string) => createHash("sha256").update(value).digest("hex");
