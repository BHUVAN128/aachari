import { assertCapabilities, assertStorageAvailable } from "@upcraft/providers";
import { getRun } from "../../runs.ts";
import { saveArtifact } from "../../artifacts/store.ts";
import { sha } from "../../artifacts/hashing.ts";
import type { StageContext } from "../context.ts";

/** §2 M1 Intake & routing — capability preflight, zero tokens. */
export const runPreflight = async (ctx: StageContext): Promise<unknown> => {
  const { runId } = ctx;
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found");
  assertCapabilities(run.domain);
  await assertStorageAvailable();
  return saveArtifact({ runId, stage: "preflight", role: "capability-report", schemaVersion: "capability-report/v1", inputHash: sha(run.snapshot), content: { checkedAt: new Date().toISOString(), domain: run.domain, renderer: "@remotion/renderer" } });
};