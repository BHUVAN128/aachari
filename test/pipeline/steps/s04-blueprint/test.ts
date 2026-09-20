import { runStepTest } from "../../setup/step-test.ts";

/**
 * s04-blueprint — Lesson blueprint. Validates learning-objective coverage, scene order, and critical-claim coverage.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "blueprint",
  input: "photosynthesis",
  artifactRole: "lesson-blueprint",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s04-blueprint outcome:" + " " + outcome.status);
});
