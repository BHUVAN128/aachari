import { gateway } from "@ai-sdk/gateway";
import { Output, ToolLoopAgent, isStepCount } from "ai";
import { IntakeBriefV2Schema, type IntakeBriefV2, type ModelRoute } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";
import { assertIntakeCapabilities } from "./capabilities.ts";
import { resolveModelRoute } from "./model-config.ts";

export { assertIntakeCapabilities };

export const INTAKE_AGENT_ID = "intake-briefing-agent";
export const INTAKE_PROMPT_VERSION = "intake-briefing/v2";

const instructions = `You are the Intake Briefing Agent for a source-grounded educational video system.

Convert the user's lesson request into the strict intake-brief/v2 schema. You are configuration extraction, not a teacher or researcher. Never invent a source, claim, citation, narration, lesson explanation, or visual asset. You have no tools and must not request web search or external retrieval.

Extract the full video configuration from the request: topic, learner level, audience category, duration, language, aspect ratio, visual style, and destination. Use these defaults only when the user did not explicitly provide a value: learner level Grade 8; audience school; duration 60 seconds; aspect ratio 16:9; visual profile "Precise, calm educational motion graphics"; destination local. Preserve the selected language exactly.

Interpret duration expressions into seconds (for example "10 minutes" becomes 600). Do not classify any topic as medical; every request is treated as a standard educational topic.

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
  output: Output.object({ schema: IntakeBriefV2Schema }),
  stopWhen: isStepCount(1),
});

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Enforces the non-negotiable intake invariant (language preservation) after schema parsing. */
export const enforceIntakeBriefPolicy = (params: { requestText: string; language: string; brief: unknown }): IntakeBriefV2 => {
  const brief = IntakeBriefV2Schema.parse(params.brief);
  if (brief.language !== params.language) {
    throw new Error("Intake Briefing Agent did not preserve the selected language exactly");
  }
  return brief;
};

export const generateIntakeBrief = async (params: { requestText: string; language: string }, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResult<IntakeBriefV2>> => {
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
