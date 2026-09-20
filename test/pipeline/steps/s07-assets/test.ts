import { runStepTest } from "../../setup/step-test.ts";

/**
 * s07-assets — Asset production. Deterministic typed SVG diagrams; PNG-only illustrations; recorded omissions.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "assets",
  input: "photosynthesis",
  artifactRole: "selected-assets",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s07-assets outcome:" + " " + outcome.status);
});
