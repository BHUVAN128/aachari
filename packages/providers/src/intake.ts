import { gateway } from "@ai-sdk/gateway";
import { Output, ToolLoopAgent, isStepCount } from "ai";
import { IntakeBriefV3Schema, type IntakeBriefV3, type ModelRoute } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";
import { assertIntakeCapabilities } from "./capabilities.ts";
import { resolveModelRoute } from "./model-config.ts";

export { assertIntakeCapabilities };

export const INTAKE_AGENT_ID = "intake-briefing-agent";
export const INTAKE_PROMPT_VERSION = "intake-briefing/v3";

const instructions = `You are the Intake Briefing Agent for a source-grounded educational video system.

Convert the user's lesson request into the strict intake-brief/v3 schema. You are configuration extraction, not a teacher or researcher. Never invent a source, claim, citation, narration, lesson explanation, or visual asset. You have no tools and must not request web search or external retrieval.

Extract only the video configuration the user actually stated: topic, learner level, audience category, duration, language, aspect ratio, visual style, and destination. If the user did not state a configuration value, return null for that field — code owns the defaults. Do not guess a learner level, audience, visual style, destination, or duration. Preserve the selected language exactly.

If the user stated a duration, interpret the expression into seconds (for example "10 minutes" becomes 600) and set durationProvided to true. If they did not state one, set durationProvided to false and durationSeconds to null.

Assess the topic's teaching complexity on a 1 (trivial) to 5 (advanced, multi-concept) scale as computedComplexity.

Choose the domain from the approved set. Do not classify any topic as medical; every medical topic is a standard educational topic.

Return only the requested structured object. Do not add fields, commentary, or reasoning.`;

/**
 * Builds the toolless intake agent for one resolved route. The agent must be
 * created per call: binding it once at module import silently ignores an env
 * route change after import.
 */
export const createIntakeAgent = (route: ModelRoute) => new ToolLoopAgent({
  id: INTAKE_AGENT_ID,
  model: gateway(route.modelRef),
  instructions,
  tools: {},
  output: Output.object({ schema: IntakeBriefV3Schema }),
  stopWhen: isStepCount(1),
});

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Enforces the non-negotiable intake invariant (language preservation) after schema parsing. */
export const enforceIntakeBriefPolicy = (params: { requestText: string; language: string; brief: unknown }): IntakeBriefV3 => {
  const brief = IntakeBriefV3Schema.parse(params.brief);
  if (brief.language !== params.language) {
    throw new Error("Intake Briefing Agent did not preserve the selected language exactly");
  }
  return brief;
};

export const generateIntakeBrief = async (params: { requestText: string; language: string }, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResult<IntakeBriefV3>> => {
  const route = resolveModelRoute("intake-brief", env);
  const prompt = `Selected language: ${params.language}\nUser lesson request:\n${params.requestText}`;
  const result = await createIntakeAgent(route).generate({ prompt });
  if (!result.output) throw new Error("Intake Briefing Agent did not return a structured brief");
  const value = enforceIntakeBriefPolicy({ requestText: params.requestText, language: params.language, brief: result.output });
  return {
    value,
    usage: {
      requestId: result.response?.id,
      model: route.model,
      inputTokens: numeric(result.usage?.inputTokens),
      cachedInputTokens: numeric(result.usage?.inputTokenDetails?.cacheReadTokens),
      outputTokens: numeric(result.usage?.outputTokens),
      reasoningTokens: numeric(result.usage?.outputTokenDetails?.reasoningTokens),
      inputCharacters: prompt.length,
      outputCharacters: JSON.stringify(value).length,
    },
  };
};

export const intakeAgentInstructions = instructions;
