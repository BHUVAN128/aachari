import { gateway } from "@ai-sdk/gateway";
import { Output, ToolLoopAgent, isStepCount } from "ai";
import { z } from "zod";
import type { ModelRoute } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";
import { resolveModelRoute } from "./model-config.ts";

/**
 * Intake content-moderation gate (Point 6, promoted).
 *
 * `processIntakeSession` had no moderation between the raw request and the
 * billable briefing call. This classifier runs before `generateIntakeBrief` and
 * before `createVideoRun`, so a rejected request costs no model tokens and
 * reserves no run. The approved route is the open-weight `gpt-oss-safeguard-20b`
 * safety-classification job in `docs/model-recommendations.md`.
 *
 * A deterministic denylist runs first (zero tokens, per the "Token discipline"
 * principle) and can only reject; the model classifier confirms everything else.
 */

export const SafetyLabelSchema = z.enum(["safe", "unsafe", "review"]);
export const SafetyClassificationSchema = z.object({
  label: SafetyLabelSchema,
  categories: z.array(z.string()),
  rationale: z.string().min(1),
});
export type SafetyClassification = z.infer<typeof SafetyClassificationSchema>;

export const SAFETY_AGENT_ID = "intake-safety-classifier";
export const SAFETY_PROMPT_VERSION = "intake-safety/v1";

export const SAFETY_FAILURE_CODES = ["safety_policy_rejected", "safety_review_required"] as const;
export type SafetyFailureCode = (typeof SAFETY_FAILURE_CODES)[number];

export const isSafetyFailureCode = (code: string | null | undefined): code is SafetyFailureCode =>
  code !== null && code !== undefined && (SAFETY_FAILURE_CODES as readonly string[]).includes(code);

/** Narrow denylist: explicit harmful intent and jailbreaks only, not science/medical language. */
export const SAFETY_DENY_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: "self-harm", pattern: /\b(kill myself|suicide method|end my life|how to self-harm)\b/i },
  { category: "violence", pattern: /\b(build a bomb|make explosives|poison someone|how to kill (a|someone)|mass shooting plan)\b/i },
  { category: "sexual-content", pattern: /\b(explicit sexual|pornograph|sexual content involving minors)\b/i },
  { category: "jailbreak", pattern: /\b(ignore (all )?previous instructions|disregard your (rules|guidelines|instructions)|you are now dan|jailbreak mode)\b/i },
  { category: "malware", pattern: /\b(write (me )?(a )?(virus|ransomware|keylogger)|exploit code|bypass (security|authentication))\b/i },
];

/** Zero-token deterministic pre-filter; can only reject, never allow. */
export const keywordSafetyClassifier = (requestText: string): SafetyClassification => {
  const categories = SAFETY_DENY_PATTERNS.filter((entry) => entry.pattern.test(requestText)).map((entry) => entry.category);
  return categories.length
    ? { label: "unsafe", categories, rationale: `Matched prohibited categories: ${categories.join(", ")}` }
    : { label: "safe", categories: [], rationale: "No prohibited content detected" };
};

const instructions = `You are a safety classifier for a source-grounded educational video system.
Classify the user's lesson request as "safe", "unsafe", or "review". Educational topics, including medical and scientific subjects, are safe: medical topics are educational, not diagnostic or prescriptive.
Return only the strict structured object with label, categories, and a one-sentence rationale.`;

export const createSafetyAgent = (route: ModelRoute) => new ToolLoopAgent({
  id: SAFETY_AGENT_ID,
  model: gateway(route.modelRef),
  instructions,
  tools: {},
  output: Output.object({ schema: SafetyClassificationSchema }),
  stopWhen: isStepCount(1),
});

/** Runs the approved model safety-classification route for one request. */
export const classifyRequestSafety = async (params: { requestText: string }, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResult<SafetyClassification>> => {
  const route = resolveModelRoute("safety-classification", env);
  const prompt = `Lesson request:\n${params.requestText}`;
  const result = await createSafetyAgent(route).generate({ prompt });
  if (!result.output) throw new Error("Safety classifier did not return a structured label");
  const value = SafetyClassificationSchema.parse(result.output);
  return {
    value,
    usage: {
      requestId: result.response?.id,
      model: route.model,
      inputTokens: typeof result.usage?.inputTokens === "number" ? result.usage.inputTokens : undefined,
      outputTokens: typeof result.usage?.outputTokens === "number" ? result.usage.outputTokens : undefined,
      inputCharacters: prompt.length,
      outputCharacters: JSON.stringify(value).length,
    },
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
