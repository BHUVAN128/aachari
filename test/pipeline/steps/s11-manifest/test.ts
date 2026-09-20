import { runStepTest } from "../../setup/step-test.ts";

/**
 * s11-manifest — Composition manifest. Voice alignment must match the approved script line by line.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "manifest",
  input: "photosynthesis",
  artifactRole: "project-manifest",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s11-manifest outcome:" + " " + outcome.status);
});
