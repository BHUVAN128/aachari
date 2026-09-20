import { runStepTest } from "../../setup/step-test.ts";

/**
 * s13-qa — Tiered QA. Tier A deterministic + exactly one Tier B consolidated review; both must converge.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "qa",
  input: "photosynthesis",
  artifactRole: "qa-report",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s13-qa outcome:" + " " + outcome.status);
});
