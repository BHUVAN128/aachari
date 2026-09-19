import type { Domain } from "@upcraft/contracts";

export type Capability = "intake" | "planning" | "verification" | "illustration" | "voice" | "storage" | "renderer" | "medical-approval";

export type CapabilityResult = { capability: Capability; available: boolean; reason?: string };

const has = (name: string) => Boolean(process.env[name]?.trim());

export const resolveCapabilities = (domain: Domain): CapabilityResult[] => [
  { capability: "intake", available: has("AI_GATEWAY_API_KEY"), reason: "AI_GATEWAY_API_KEY is required for chat intake" },
  { capability: "planning", available: has("OPENAI_API_KEY"), reason: "OPENAI_API_KEY is required" },
  { capability: "verification", available: has("GEMINI_API_KEY"), reason: "GEMINI_API_KEY is required" },
  { capability: "illustration", available: has("GEMINI_API_KEY"), reason: "GEMINI_API_KEY is required" },
  { capability: "voice", available: has("ELEVENLABS_API_KEY") && has("ELEVENLABS_VOICE_ID"), reason: "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required" },
  { capability: "storage", available: has("S3_ENDPOINT") && has("S3_BUCKET") && has("S3_ACCESS_KEY_ID") && has("S3_SECRET_ACCESS_KEY"), reason: "S3 storage variables are required" },
  { capability: "renderer", available: has("RENDER_OUTPUT_DIR"), reason: "RENDER_OUTPUT_DIR is required" },
  { capability: "medical-approval", available: domain !== "medical" || (has("CLERK_SECRET_KEY") && has("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")), reason: "Clerk keys are required for medical approval" },
];

export const assertCapabilities = (domain: Domain) => {
  const requiredCapabilities: Capability[] = ["planning", "verification", "voice", "storage", "renderer"];
  if (domain === "medical") requiredCapabilities.push("medical-approval");
  const missing = resolveCapabilities(domain).filter((capability) => requiredCapabilities.includes(capability.capability) && !capability.available);
  if (missing.length) {
    throw new Error(`Capability preflight failed: ${missing.map((capability) => capability.capability).join(", ")}. ${missing.map((capability) => capability.reason).join(" ")}`);
  }
};

export const assertIntakeCapabilities = () => {
  const intake = resolveCapabilities("standard").find((capability) => capability.capability === "intake");
  if (!intake?.available) throw new Error(intake?.reason ?? "Chat intake capability is unavailable");
};
