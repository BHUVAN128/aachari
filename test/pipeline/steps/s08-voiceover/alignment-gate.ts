import type { WordTiming } from "@upcraft/contracts";
import { validateMonotonicWords, type AlignmentIssue } from "./line-synthesis.ts";

/**
 * W2 — s08 pre-save alignment integrity + bounded re-synthesis (test-local first;
 * promoted into `packages/pipeline/src/media-qa.ts` and the s08 handler at Phase 6).
 *
 * Today `validateVoiceAlignment` (media-qa.ts) checks only that words exist, that
 * a duration was measured, and that the trailing gap is within tolerance. It does
 * not check per-word positive length or monotonicity, so the first strict check in
 * the chain is s09's `endMs <= startMs` throw — after s08 has already persisted
 * `voiceover/v1` and the narration asset. Because s08 is idempotent on
 * `inputHash`, a retry replays the same bad artifact and s09 throws forever: a
 * permanent idempotent deadlock. `elevenlabs.ts` floors starts and ceils ends, so
 * a very short word (start == end == 1.2s) becomes `1200, 1200` and manufactures
 * exactly this defect.
 *
 * The fix is a zero-token integrity gate that runs *before* `putPrivateObject`
 * and `saveArtifact`, plus a bounded re-synthesis policy. A failed attempt is a
 * recorded retry; timestamps are never healed or rewritten, because the alignment
 * is evidence that s11 (line-by-line voice match) and s13 (reconstruction) depend
 * on. s09 keeps its throw as defense-in-depth.
 */

export const MAX_ALIGNMENT_ATTEMPTS = 3;
export const ALIGNMENT_DEFECT = "ALIGNMENT_DEFECT";

/**
 * The pre-save gate. Wraps the existing `validateMonotonicWords` (positive length
 * + monotonic starts) and adds a count sanity check so an empty alignment or a
 * malformed word is rejected before anything is persisted.
 */
export const validateAlignmentIntegrity = (words: WordTiming[]): AlignmentIssue[] => {
  if (!words.length) {
    return [{ rule: "alignment-empty", evidence: {}, remediation: "Re-synthesize the narration; the TTS alignment returned no words." }];
  }
  const malformed = words.filter((word, index) => typeof word.text !== "string" || !word.text.length || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= 0);
  const issues = validateMonotonicWords(words);
  if (malformed.length) {
    issues.unshift({ rule: "alignment-word-malformed", evidence: { count: malformed.length, sample: malformed.slice(0, 3) }, remediation: "Re-map from the rendered narration; every word needs non-empty text and finite non-negative bounds." });
  }
  return issues;
};

export type AlignmentAttemptOutcome = "completed" | "alignment-defect";
export type AlignmentAttempt = { attempt: number; outcome: AlignmentAttemptOutcome; issues: AlignmentIssue[] };

export class AlignmentDefectExhaustedError extends Error {
  public readonly code = ALIGNMENT_DEFECT;
  public readonly attempts: AlignmentAttempt[];

  public constructor(attempts: AlignmentAttempt[]) {
    super(`${ALIGNMENT_DEFECT}: alignment still failed integrity after ${attempts.length} attempt(s): ${attempts.at(-1)?.issues.map((issue) => issue.rule).join(", ") ?? "unknown"}`);
    this.name = "AlignmentDefectExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Bounded generate → gate loop for narration synthesis. Each attempt calls
 * `synthesize`, which returns both the mapped words and the opaque synthesis
 * value. A defect is retried up to `maxAttempts`; exhaustion raises a typed,
 * visible failure so no artifact and no `media_assets` row is written and a later
 * replay re-synthesizes instead of replaying a poisoned hash.
 */
export const runBoundedAlignmentSynthesis = async <T>(params: {
  synthesize: (attempt: number) => Promise<{ words: WordTiming[]; value: T }>;
  /** Additional zero-token gate (for example measured pauses) composed after integrity. */
  gate?: (words: WordTiming[]) => AlignmentIssue[];
  maxAttempts?: number;
  onAttempt?: (attempt: AlignmentAttempt) => void;
}): Promise<{ value: T; words: WordTiming[]; attempts: AlignmentAttempt[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_ALIGNMENT_ATTEMPTS;
  const attempts: AlignmentAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { words, value } = await params.synthesize(attempt);
    const issues = [...validateAlignmentIntegrity(words), ...(params.gate?.(words) ?? [])];
    const outcome: AlignmentAttemptOutcome = issues.length ? "alignment-defect" : "completed";
    const record: AlignmentAttempt = { attempt, outcome, issues };
    attempts.push(record);
    params.onAttempt?.(record);
    if (outcome === "completed") return { value, words, attempts };
  }
  throw new AlignmentDefectExhaustedError(attempts);
};
