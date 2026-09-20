import { runStepTest } from "../../setup/step-test.ts";

/**
 * s12-preview-render — Preview render. Render-integrity is probed from the produced bytes.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "preview-render",
  input: "photosynthesis",
  artifactRole: "preview-render",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s12-preview-render outcome:" + " " + outcome.status);
});
