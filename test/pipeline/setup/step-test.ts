import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { StageName } from "@upcraft/contracts";
import { createVideoRun, getRun } from "@upcraft/pipeline";
import { closeDb } from "@upcraft/db";
import { prepareHarness } from "./stage-context.ts";
import { runStage, artifactFor, type StepRunResult } from "./runner.ts";
import { buildRunInput, type HarnessInputName } from "./inputs.ts";
import { hydrateFrozenUpstream } from "./frozen.ts";
import { loadContract, validateArtifactContract } from "./contract.ts";
import { createLogger } from "./logger.ts";
import type { StageContext } from "@upcraft/pipeline/pipeline";

/**
 * Shared skeleton for a step test. Each step's `test.ts` calls this with its
 * artifact role, its `expected-output.json` path, and any extra assertions.
 *
 * The helper owns the common shape:
 *   1. prepare the harness (test DB + bucket),
 *   2. create a run from the named mock input,
 *   3. hydrate frozen upstream artifacts (correct-then-combine),
 *   4. run the real stage handler,
 *   5. validate the emitted artifact against the step contract,
 *   6. print the NDJSON-derived summary.
 *
 * A blocked stage (missing credential) prints a visible reason and returns
 * without asserting, so the sandbox can run without every provider key.
 */
export type StepTestOptions = {
  stage: StageName;
  input: HarnessInputName;
  /** Artifact role the step must emit; omit for stages that emit none. */
  artifactRole?: string;
  /** Relative path to the step's expected-output.json. */
  contractFile?: string;
  /** Extra assertions over the produced run. */
  assert?: (params: { runId: string; result: StepRunResult; artifact: Awaited<ReturnType<typeof artifactFor>> }) => Promise<void> | void;
  /** Install verifier/transport shims before the handler runs. */
  install?: (runId: string) => void | Promise<void>;
  /** Skeleton steps record a visible failure instead of asserting while incomplete. */
  allowFailure?: boolean;
};

export type StepTestOutcome = { status: "blocked" | "failed" | "passed"; runId: string; reason?: string };

export const runStepTest = async (options: StepTestOptions): Promise<StepTestOutcome> => {
  await prepareHarness();
  const runId = await createVideoRun(await buildRunInput(options.input));

  await hydrateFrozenUpstream(runId);
  const result = await runStage({ stage: options.stage, input: options.input, runId, allowBlocked: true, ...(options.install ? { install: options.install } : {}) });

  if (result.blockReason) {
    console.log(`${options.stage} BLOCKED (credential): ${result.blockReason}`);
    await closeDb();
    return { status: "blocked", runId, reason: result.blockReason };
  }
  if (result.checkpointOutcome === "failed" && options.allowFailure) {
    console.log(`${options.stage} recorded a visible failure: ${result.failureMessage ?? ""}`);
    await closeDb();
    return { status: "failed", runId, ...(result.failureMessage ? { reason: result.failureMessage } : {}) };
  }
  assert.notEqual(result.checkpointOutcome, "failed", `${options.stage} failed visibly: ${result.failureMessage ?? ""}`);

  const artifact = options.artifactRole ? await artifactFor(runId, options.artifactRole) : undefined;
  if (options.artifactRole) {
    assert.ok(artifact?.content, `${options.stage} must persist a "${options.artifactRole}" artifact`);
    if (options.contractFile) {
      const contract = await loadContract(fileURLToPath(new URL(options.contractFile, import.meta.url)));
      const failures = validateArtifactContract(artifact!.content, contract);
      assert.deepEqual(failures, [], `${options.artifactRole} contract failures: ${failures.join("; ")}`);
    }
  }
  await options.assert?.({ runId, result, artifact });

  const logger = await createLogger(runId, options.stage);
  const summary = await logger.capture({ checkpointOutcome: result.checkpointOutcome, artifactRole: options.artifactRole ?? null, artifactSha256: artifact?.sha256 ?? null });
  console.log(`${options.stage} PASS — outcomes: ${summary.outcomes.join(" → ") || "(none)"}`);
  await closeDb();
  return { status: "passed", runId };
};

/** True when a run reached a given terminal status; used by workflow assertions. */
export const runStatus = async (runId: string) => (await getRun(runId))?.status ?? null;

export type { StageContext };