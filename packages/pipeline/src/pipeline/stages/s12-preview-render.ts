import { renderMaster } from "../../render/master.ts";
import type { StageContext } from "../context.ts";

/** §10 M9 preview render — proves the composition before QA. */
export const runPreviewRender = (ctx: StageContext) => renderMaster(ctx, "preview");