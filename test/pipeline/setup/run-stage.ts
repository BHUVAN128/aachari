import { HARNESS_INPUTS, type HarnessInputName } from "./inputs.ts";
import { prepareHarness } from "./stage-context.ts";
import { runStage } from "./runner.ts";
import { runIntakeHarness } from "./intake-runner.ts";
import type { StageName } from "@upcraft/contracts";

/**
 * Runs a single step test from the command line:
 *
 *   node test/pipeline/setup/run-stage.ts s02 --input photosynthesis
 *
 * The step's own `test.ts` owns the assertions; this entry point exists so a
 * step can be executed and inspected on its own before it is combined.
 */
export const STAGE_COMMAND_ALIASES: Record<string, StageName> = {
  s01: "preflight",
  s02: "research",
  s03: "fact-verification",
  s04: "blueprint",
  s05: "script",
  s06: "visual-bible",
  s07: "assets",
  s08: "voiceover",
  s09: "captions",
  s10: "spatial-layout",
  s11: "manifest",
  s12: "preview-render",
  s13: "qa",
  s14: "approval",
  s15: "final-render",
  s16: "release-record",
};

const parseArgs = (argv: string[]) => {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const inputIndex = argv.indexOf("--input");
  const input = (inputIndex >= 0 ? argv[inputIndex + 1] : "photosynthesis") as HarnessInputName;
  return { stageArg: positional[0], input };
};

const main = async () => {
  const { stageArg, input } = parseArgs(process.argv.slice(2));
  if (!stageArg) throw new Error(`Usage: run-stage.ts <s00..s16|stage-name> --input <${Object.keys(HARNESS_INPUTS).join("|")}>`);
  // s00-intake is a pre-run step: it does not use the stage DB/MinIO resources.
  if (stageArg === "s00" || stageArg === "intake" || stageArg === "s00-intake") {
    const result = await runIntakeHarness({ requestText: HARNESS_INPUTS[input].topic, language: "en" });
    console.log(`[s00-intake] ${result.status}${result.failureMessage ? `: ${result.failureMessage}` : ""}`);
    process.exit(result.status === "failed" ? 1 : 0);
  }
  const stage = STAGE_COMMAND_ALIASES[stageArg] ?? (stageArg as StageName);
  await prepareHarness();
  const result = await runStage({ stage, input, allowBlocked: true });
  if (result.blockReason) console.log(`[${stage}] blocked: ${result.blockReason}`);
  const { closeDb } = await import("@upcraft/db");
  await closeDb();
  process.exit(result.checkpointOutcome === "failed" ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});