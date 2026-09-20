import { runStepTest } from "../../setup/step-test.ts";

/**
 * s16-release-record — Immutable release record assembled from locked artifacts, checkpoints, usage, approval, and renders.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "release-record",
  input: "photosynthesis",
  artifactRole: "release-record",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s16-release-record outcome:" + " " + outcome.status);
});
