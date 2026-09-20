import type { StageName } from "@upcraft/contracts";
import type { StageHandler } from "./context.ts";
import { runPreflight } from "./stages/s01-preflight.ts";
import { runResearch } from "./stages/s02-research.ts";
import { runFactVerification } from "./stages/s03-fact-verification.ts";
import { runBlueprint } from "./stages/s04-blueprint.ts";
import { runScript } from "./stages/s05-script.ts";
import { runVisualBible } from "./stages/s06-visual-bible.ts";
import { runAssets } from "./stages/s07-assets/index.ts";
import { runVoiceover } from "./stages/s08-voiceover.ts";
import { runCaptions } from "./stages/s09-captions.ts";
import { runSpatialLayout } from "./stages/s10-spatial-layout.ts";
import { runManifest } from "./stages/s11-manifest.ts";
import { runPreviewRender } from "./stages/s12-preview-render.ts";
import { runQa } from "./stages/s13-qa.ts";
import { runFinalRender } from "./stages/s15-final-render.ts";
import { runReleaseRecord } from "./stages/s16-release-record.ts";

/**
 * The dependency graph encoded in one auditable artifact. `video-generation-process.md`
 * §13 requires the stage order and input dependencies to be fixed; keeping the
 * handler table and the input-role table side by side makes a violation a visible
 * code change rather than a buried one.
 *
 * `approval` is intentionally absent: it is executor-owned (it has no model
 * handler and may advance automatically for standard school/college releases).
 */
export const stageHandlers: Partial<Record<StageName, StageHandler>> = {
  "preflight": runPreflight, "research": runResearch, "fact-verification": runFactVerification, "blueprint": runBlueprint,
  "script": runScript, "visual-bible": runVisualBible, "assets": runAssets, "voiceover": runVoiceover,
  "captions": runCaptions, "spatial-layout": runSpatialLayout, "manifest": runManifest,
  "preview-render": runPreviewRender, "qa": runQa, "final-render": runFinalRender, "release-record": runReleaseRecord,
};

/**
 * The locked input roles each stage consumes. Read by `getStageInputHash` so the
 * hash of a stage's inputs and this table can never drift apart.
 */
export const stageInputRoles: Partial<Record<StageName, string[]>> = {
  "fact-verification": ["source-evidence-map", "fact-pack"],
  blueprint: ["fact-pack"],
  script: ["lesson-blueprint", "fact-pack"],
  "visual-bible": ["approved-script"],
  assets: ["approved-script", "visual-bible", "lesson-blueprint", "fact-pack"],
  voiceover: ["approved-script"],
  captions: ["voiceover"],
  "spatial-layout": ["approved-script", "visual-bible", "selected-assets"],
  manifest: ["voiceover", "caption-timings", "resolved-layout", "approved-script", "lesson-blueprint", "visual-bible", "selected-assets"],
  "preview-render": ["project-manifest", "voiceover", "selected-assets"],
  qa: ["preview-render", "project-manifest", "fact-pack", "approved-script", "resolved-layout", "selected-assets"],
  approval: ["qa-report", "preview-render"],
  "final-render": ["project-manifest", "voiceover", "selected-assets"],
  "release-record": ["final-render", "project-manifest", "qa-report"],
};