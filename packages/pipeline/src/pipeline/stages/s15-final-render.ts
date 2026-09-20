import { renderMaster } from "../../render/master.ts";
import type { StageContext } from "../context.ts";

/** §12 M11 final render — the approved master, plus transcript and variants. */
export const runFinalRender = (ctx: StageContext) => renderMaster(ctx, "final");