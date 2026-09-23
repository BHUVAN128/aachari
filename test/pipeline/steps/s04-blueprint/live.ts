import { runStepTest } from "../../setup/step-test.ts";

/**
 * s04-blueprint live-run skeleton. The deterministic hardening suite lives in
 * `test.ts` (zero provider keys and zero database); this file runs the real
 * `runBlueprint` handler against the harness and records a visible failure while
 * the step is not yet green.
 *
 * Kept separate so `node test/pipeline/steps/s04-blueprint/test.ts` never needs
 * Postgres/MinIO. Remove `allowFailure` and add step-specific assertions once the
 * upstream chain is frozen and the hardening modules are promoted.
 */
void runStepTest({
  stage: "blueprint",
  input: "photosynthesis",
  artifactRole: "lesson-blueprint",
  contractFile: "./expected-output.json",
  allowFailure: true,
}).then((outcome) => {
  console.log("s04-blueprint live outcome: " + outcome.status);
});
