import { STAGE_ORDER } from "@upcraft/contracts";
import { estimateCostMicrounits } from "@upcraft/providers";
import { getDb, providerUsage, videoRuns } from "@upcraft/db";
import { eq } from "drizzle-orm";
import { prepareHarness, resetHarness } from "./stage-context.ts";
import { runStage } from "./runner.ts";
import { HARNESS_INPUTS, type HarnessInputName } from "./inputs.ts";

/**
 * Chains the steps end-to-end after each has gone green individually:
 *
 *   node test/pipeline/setup/run-all.ts --input photosynthesis
 *
 * It stops at the first blocked or failed stage so a partial run is never
 * reported as a completed video, and prints the cumulative run cost accumulated
 * from the same `estimateCostMicrounits` math the production ledger uses.
 */
const main = async () => {
  const inputIndex = process.argv.indexOf("--input");
  const input = (inputIndex >= 0 ? process.argv[inputIndex + 1] : "photosynthesis") as HarnessInputName;
  if (!HARNESS_INPUTS[input]) throw new Error(`Unknown input "${input}". Known: ${Object.keys(HARNESS_INPUTS).join(", ")}`);

  await prepareHarness();
  const runId = await (async () => {
    const { createVideoRun } = await import("@upcraft/pipeline");
    const { buildRunInput } = await import("./inputs.ts");
    return createVideoRun(await buildRunInput(input));
  })();

  console.log(`\nrun-all: input=${input} runId=${runId}\n`);
  for (const stage of STAGE_ORDER) {
    if (stage === "approval") continue; // executor-owned, advanced by the qa stage
    const result = await runStage({ stage, input, runId, allowBlocked: true });
    if (result.checkpointOutcome === "blocked") {
      console.log(`\nrun-all stopped at ${stage}: ${result.blockReason}`);
      break;
    }
    if (result.checkpointOutcome === "failed") {
      console.log(`\nrun-all stopped at ${stage}: visible failure ${result.failureCode}: ${result.failureMessage}`);
      break;
    }
  }

  const db = getDb();
  const usage = await db.select().from(providerUsage).where(eq(providerUsage.runId, runId));
  const cost = usage.reduce((sum, row) => sum + (estimateCostMicrounits(row.provider, { inputTokens: row.inputTokens ?? undefined, outputTokens: row.outputTokens ?? undefined, inputCharacters: row.inputCharacters ?? undefined }) ?? 0), 0);
  const run = await db.select().from(videoRuns).where(eq(videoRuns.id, runId)).limit(1).then((rows) => rows[0]);
  console.log(`\nrun-all summary: status=${run?.status ?? "unknown"} attempts=${usage.length} cumulativeCost=${cost}µ$`);
  await resetHarness();
  process.exit(run?.status === "completed" ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});