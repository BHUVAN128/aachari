import { buildSoundPlan } from "../../../planning.ts";
import type { SceneDirection } from "../../../planning.ts";

/**
 * §7 M6 sound plan — DEFERRED under `video-generation-process.md`.
 *
 * Music/SFX selection is not a release gate while deferred; narration must
 * remain intelligible without it. The retained deterministic implementation
 * records an explicit per-scene omission. It is intentionally not wired into
 * `runAssets`; promoting it to a release gate is a governing-document change
 * under `AGENTS.md`.
 */
export const buildDeferredSoundPlan = (directions: SceneDirection[]) => buildSoundPlan(directions);