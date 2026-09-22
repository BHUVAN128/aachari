import { z } from "zod";

/**
 * Intake hardening — content moderation gate (Point 6).
 *
 * `processIntakeSession` currently has zero moderation between the raw request
 * text and the billable model call + `createVideoRun`. This gate runs before any
 * billing and before a run identity is reserved, so a rejected request costs
 * nothing and leaves no run.
 *
 * The approved safety-classification route is the open-weight `gpt-oss-safeguard-20b`
 * job in `docs/model-recommendations.md` ("suitable for drafts, routing, and
 * policy checks"). A safety rejection is a terminal failure, never transient, so
 * it must bypass `retryable()` / `classifyIntakeFailure`.
 *
 * Sandbox-first: the classifier is injectable and the default is an offline,
 * deterministic keyword classifier, so harness tests never send dangerous content
 * to a provider. `createModelSafetyClassifier` is the promotion-ready model route.
 */

export const SafetyLabelSchema = z.enum(["safe", "unsafe", "review"]);
export const SafetyClassificationSchema = z.object({
  label: SafetyLabelSchema,
  categories: z.array(z.string()),
  rationale: z.string().min(1),
});
export type SafetyClassification = z.infer<typeof SafetyClassificationSchema>;

export const SAFETY_FAILURE_CODES = ["safety_policy_rejected", "safety_review_required"] as const;
export type SafetyFailureCode = (typeof SAFETY_FAILURE_CODES)[number];

export const isSafetyFailureCode = (code: string | null | undefined): code is SafetyFailureCode => code !== null && code !== undefined && (SAFETY_FAILURE_CODES as readonly string[]).includes(code);

export type SafetyClassifier = (requestText: string) => SafetyClassification | Promise<SafetyClassification>;

/** Approved route identity for promotion (no production capability exists yet). */
export const SAFETY_ROUTE = {
  capability: "safety-classification",
  provider: "ai-gateway",
  model: "gpt-oss-safeguard-20b",
  modelRef: "openai/gpt-oss-safeguard-20b",
  envKey: "INTAKE_SAFETY_MODEL",
} as const;

/**
 * A deliberately narrow denylist: it catches explicit harmful intent and
 * jailbreaks without flagging ordinary educational medical/science language.
 */
export const SAFETY_DENY_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: "self-harm", pattern: /\b(kill myself|suicide method|end my life|how to self-harm)\b/i },
  { category: "violence", pattern: /\b(build a bomb|make explosives|poison someone|how to kill (a|someone)|mass shooting plan)\b/i },
  { category: "sexual-content", pattern: /\b(explicit sexual|pornograph|sexual content involving minors)\b/i },
  { category: "jailbreak", pattern: /\b(ignore (all )?previous instructions|disregard your (rules|guidelines|instructions)|you are now dan|jailbreak mode)\b/i },
  { category: "malware", pattern: /\b(write (me )?(a )?(virus|ransomware|keylogger)|exploit code|bypass (security|authentication))\b/i },
];

/** Offline deterministic classifier used by the sandbox default path. */
export const keywordSafetyClassifier: SafetyClassifier = (requestText) => {
  const categories = SAFETY_DENY_PATTERNS.filter((entry) => entry.pattern.test(requestText)).map((entry) => entry.category);
  return categories.length
    ? { label: "unsafe", categories, rationale: `Matched prohibited categories: ${categories.join(", ")}` }
    : { label: "safe", categories: [], rationale: "No prohibited content detected" };
};

export const SAFETY_INSTRUCTIONS = `You are a safety classifier for a source-grounded educational video system.
Classify the user's lesson request as "safe", "unsafe", or "review". Educational topics, including medical and scientific subjects, are safe: medical topics are educational, not diagnostic or prescriptive.
Return only the strict structured object with label, categories, and a one-sentence rationale.`;

/**
 * The model-backed classifier runner, injected so this sandbox module does not
 * import the gateway SDK directly. At promotion it is wired in
 * `packages/providers` to an agent over the approved safety route (the same
 * `ToolLoopAgent` + `Output.object` pattern as the intake briefing agent),
 * mirroring `createIntakeAgent`.
 */
export type SafetyModelRunner = (params: { modelRef: string; instructions: string; prompt: string }) => Promise<unknown>;

/** Builds a model-backed classifier from an injected runner (promotion-ready). */
export const createModelSafetyClassifier = (run: SafetyModelRunner, modelRef: string = SAFETY_ROUTE.modelRef): SafetyClassifier => {
  return async (requestText: string) => {
    const output = await run({ modelRef, instructions: SAFETY_INSTRUCTIONS, prompt: `Lesson request:\n${requestText}` });
    return SafetyClassificationSchema.parse(output);
  };
};

export type SafetyGateDecision = { allowed: boolean; failureCode: SafetyFailureCode | null };

/** Only an explicit "safe" label advances; "review" and "unsafe" block the run. */
export const decideSafetyGate = (classification: SafetyClassification): SafetyGateDecision =>
  classification.label === "safe"
    ? { allowed: true, failureCode: null }
    : classification.label === "unsafe"
      ? { allowed: false, failureCode: "safety_policy_rejected" }
      : { allowed: false, failureCode: "safety_review_required" };

export type ModerationResult = SafetyGateDecision & { classification: SafetyClassification };

/**
 * Runs the moderation gate. Terminates before any provider call or run identity
 * is reserved; the caller records `failureCode` and never schedules a retry.
 */
export const moderateRequest = async (params: { requestText: string; classify?: SafetyClassifier }): Promise<ModerationResult> => {
  const classification = SafetyClassificationSchema.parse(await (params.classify ?? keywordSafetyClassifier)(params.requestText));
  return { ...decideSafetyGate(classification), classification };
};
