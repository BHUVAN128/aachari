import { runStepTest } from "../../setup/step-test.ts";

/**
 * s14-approval — Approval is executor-owned. Automatic standard school/college release; any selected AI illustration forces human review.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "approval",
  input: "photosynthesis",
  allowFailure: true,
}).then((outcome) => {
  console.log("s14-approval outcome:" + " " + outcome.status);
});
