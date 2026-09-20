import { runStepTest } from "../../setup/step-test.ts";

/**
 * s01-preflight — Capability preflight. Emits a capability report after asserting required capabilities and storage.
 *
 * Skeleton: run the real stage against the harness and record a visible failure
 * while the step is not yet green. Remove `allowFailure` and add step-specific
 * assertions once the upstream chain is frozen.
 */
void runStepTest({
  stage: "preflight",
  input: "photosynthesis",
  artifactRole: "capability-report",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s01-preflight outcome:" + " " + outcome.status);
});
