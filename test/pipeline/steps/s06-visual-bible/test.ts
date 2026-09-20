import { runStepTest } from "../../setup/step-test.ts";

/**
 * s06-visual-bible — Visual bible. One project-level look locked with the approved script.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "visual-bible",
  input: "photosynthesis",
  artifactRole: "visual-bible",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s06-visual-bible outcome:" + " " + outcome.status);
});
