import { runStepTest } from "../../setup/step-test.ts";

/**
 * s15-final-render — Final master plus SRT transcript and resolution variants.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "final-render",
  input: "photosynthesis",
  artifactRole: "final-render",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s15-final-render outcome:" + " " + outcome.status);
});
