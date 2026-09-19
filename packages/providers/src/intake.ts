import { gateway } from "@ai-sdk/gateway";
import { Output, ToolLoopAgent, isStepCount } from "ai";
import { IntakeBriefSchema, type IntakeBrief } from "@upcraft/contracts";
import type { ProviderResult } from "./usage.ts";
import { assertIntakeCapabilities } from "./capabilities.ts";

export { assertIntakeCapabilities };

export const INTAKE_AGENT_ID = "intake-briefing-agent";
export const INTAKE_PROMPT_VERSION = "intake-briefing/v1";
export const INTAKE_MODEL = () => process.env.INTAKE_BRIEF_MODEL ?? "openai/gpt-5.6-luna";

const instructions = `You are the Intake Briefing Agent for a source-grounded educational video system.

Convert only the user's lesson request into the strict intake-brief schema. You are metadata extraction, not a teacher or researcher. Never invent a source, claim, citation, narration, lesson explanation, visual asset, or medical advice. You have no tools and must not request web search or external retrieval.

Use these defaults when the user did not explicitly provide a value: learner level Grade 8; audience school; risk domain standard; duration 60 seconds; visual profile "Precise, calm educational motion graphics". Preserve the selected language exactly. Classify potentially medical, diagnosis, treatment, patient, drug, symptom, or health-related requests conservatively as medical. Do not downgrade an ambiguous health request to standard.

Return only the requested structured object. Do not add fields, commentary, or reasoning.`;

const agent = new ToolLoopAgent({
  id: INTAKE_AGENT_ID,
  model: gateway(INTAKE_MODEL()),
  instructions,
  tools: {},
  output: Output.object({ schema: IntakeBriefSchema }),
  stopWhen: isStepCount(1),
});

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const generateIntakeBrief = async (params: { requestText: string; language: string }): Promise<ProviderResult<IntakeBrief>> => {
  const prompt = `Selected language: ${params.language}\nUser lesson request:\n${params.requestText}`;
  const result = await agent.generate({ prompt });
  if (!result.output) throw new Error("Intake Briefing Agent did not return a structured brief");
  const value = IntakeBriefSchema.parse(result.output);
  return {
    value,
    usage: {
      requestId: result.response?.id,
      model: INTAKE_MODEL(),
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
