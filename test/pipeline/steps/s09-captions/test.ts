import { runStepTest } from "../../setup/step-test.ts";

/**
 * s09-captions — Captions derived deterministically from the locked word alignment.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "captions",
  input: "photosynthesis",
  artifactRole: "caption-timings",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s09-captions outcome:" + " " + outcome.status);
});
