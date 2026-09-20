import { runStepTest } from "../../setup/step-test.ts";

/**
 * s10-spatial-layout — Spatial layout. Deterministic solver assertions; drift <= 0.75px; no caption overlap.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "spatial-layout",
  input: "photosynthesis",
  artifactRole: "resolved-layout",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s10-spatial-layout outcome:" + " " + outcome.status);
});
