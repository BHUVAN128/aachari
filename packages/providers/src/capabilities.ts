import type { Domain, ModelCapability } from "@upcraft/contracts";
import { MODEL_ROUTES, requiredCredentials, resolveModelRoute } from "./model-config.ts";

export type Capability = "intake" | "safety" | "planning" | "verification" | "research" | "illustration" | "voice" | "storage" | "renderer";

export type CapabilityResult = { capability: Capability; available: boolean; reason?: string | undefined; model?: string | undefined };

const has = (name: string) => Boolean(process.env[name]?.trim());

/** Maps a public capability to the model capability whose credentials gate it. */
const MODEL_CAPABILITY: Partial<Record<Capability, ModelCapability>> = {
  intake: "intake-brief",
  safety: "safety-classification",
  planning: "planning",
  verification: "fact-verification",
  research: "research-web",
  illustration: "illustration",
  voice: "narration",
};

const modelCredentialResult = (capability: Capability, modelCapability: ModelCapability, env?: NodeJS.ProcessEnv): CapabilityResult => {
  const credentials = requiredCredentials(modelCapability);
  const available = credentials.every((name) => (env ? Boolean(env[name]?.trim()) : has(name)));
  const resolved = resolveModelRoute(modelCapability, env);
  return {
    capability,
    available,
    reason: available ? undefined : `${credentials.join(", ")} ${credentials.length > 1 ? "are" : "is"} required`,
    model: resolved.modelRef,
  };
};

export const resolveCapabilities = (domain: Domain, env?: NodeJS.ProcessEnv): CapabilityResult[] => [
  modelCredentialResult("intake", MODEL_CAPABILITY.intake!, env),
  modelCredentialResult("safety", MODEL_CAPABILITY.safety!, env),
  modelCredentialResult("planning", MODEL_CAPABILITY.planning!, env),
  modelCredentialResult("verification", MODEL_CAPABILITY.verification!, env),
  modelCredentialResult("research", MODEL_CAPABILITY.research!, env),
  modelCredentialResult("illustration", MODEL_CAPABILITY.illustration!, env),
  modelCredentialResult("voice", MODEL_CAPABILITY.voice!, env),
  { capability: "storage", available: has("S3_ENDPOINT") && has("S3_BUCKET") && has("S3_ACCESS_KEY_ID") && has("S3_SECRET_ACCESS_KEY"), reason: "S3 storage variables are required" },
  { capability: "renderer", available: has("RENDER_OUTPUT_DIR"), reason: "RENDER_OUTPUT_DIR is required" },
];

/** The model ref shown for a capability, never a secret value. */
export const resolvedModelRef = (capability: ModelCapability, env?: NodeJS.ProcessEnv) => resolveModelRoute(capability, env).modelRef;

/** The env key that overrides a model capability's route, for operator display. */
export const modelEnvKey = (capability: ModelCapability) => MODEL_ROUTES[capability].envKey;

/**
 * Capabilities a run must have before any billable work. Web research is only
 * required for source-less runs; a run with a user-supplied source must not be
 * blocked on the Brave credential.
 */
export const requiredCapabilitiesFor = (sourceCount: number): Capability[] =>
  sourceCount === 0 ? ["planning", "verification", "research", "voice", "storage", "renderer"] : ["planning", "verification", "voice", "storage", "renderer"];

export const assertCapabilities = (domain: Domain, options: { sourceCount?: number } = {}) => {
  const requiredCapabilities = requiredCapabilitiesFor(options.sourceCount ?? 0);
  void domain;
  const missing = resolveCapabilities(domain).filter((capability) => requiredCapabilities.includes(capability.capability) && !capability.available);
  if (missing.length) {
    throw new Error(`Capability preflight failed: ${missing.map((capability) => capability.capability).join(", ")}. ${missing.map((capability) => capability.reason).join(" ")}`);
  }
};

export const assertIntakeCapabilities = () => {
  const capabilities = resolveCapabilities("standard");
  const intake = capabilities.find((capability) => capability.capability === "intake");
  if (!intake?.available) throw new Error(intake?.reason ?? "Chat intake capability is unavailable");
  const safety = capabilities.find((capability) => capability.capability === "safety");
  if (!safety?.available) throw new Error(safety?.reason ?? "Chat intake safety-classification capability is unavailable");
};
