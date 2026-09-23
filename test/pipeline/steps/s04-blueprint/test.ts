import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_SCENE_SECONDS, MIN_SCENE_SECONDS, sceneBoundsFor, validateSceneDensity } from "./pacing-guard.ts";
import { CRITICAL_CLAIMS_PER_MINUTE, MAX_CLAIMS_PER_SCENE, criticalClaimBudget, validateClaimBudget, validateClaimsPerScene } from "./claim-budget.ts";
import { VISUAL_BEAT_PROMPT_RULES, hasVisualDirectionKeyword, isNonEnglishScript, validateVisualBeat } from "./visual-directives.ts";
import {
  BLUEPRINT_QA_EXHAUSTED,
  MAX_BLUEPRINT_ATTEMPTS,
  BlueprintQaExhaustedError,
  BlueprintQaRejectionError,
  buildBlueprintRepairPrompt,
  runBoundedBlueprintRepairLoop,
  type BlueprintCorrection,
} from "./blueprint-repair.ts";
import { blueprintInputHash } from "./input-composite.ts";

/**
 * s04 — Lesson blueprint hardening (Flaws 1–6).
 *
 * Fully deterministic, zero provider keys and zero database:
 *   1. Flaw 2: scene-density guard over 30/120/600s durations.
 *   2. Flaw 3: pre-generation critical-claim budget (25 vs 8) + per-scene cap.
 *   3. Flaws 4/6: visual-beat validation (localized / vague / non-directive / valid).
 *   4. Flaw 5: bounded repair loop — accept after two failures including the exact
 *      C04→C02 oscillation, plus terminal exhaustion at 3 attempts.
 *   5. Flaw 1: composite input hash binds the blueprint to the frozen snapshot.
 *
 * The live handler skeleton (blocked without provider keys) lives in `live.ts`.
 */
const localSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const planWith = (covered: string[]) => ({ covered });
const requiredClaims = ["claim-c02", "claim-c04"];

const verifyCoverage = (plan: { covered: string[] }) => {
  const missing = requiredClaims.filter((id) => !plan.covered.includes(id));
  if (missing.length) {
    throw new BlueprintQaRejectionError({
      issues: [{ rule: "blueprint-objective-coverage", evidence: { uncoveredCritical: missing }, remediation: "Add a scene that teaches every critical claim." }],
      missingClaimIds: missing,
      rationale: `critical claims uncovered: ${missing.join(", ")}`,
    });
  }
};

const main = async () => {
  // --- Flaw 2: scene-density guard ---
  assert.equal(MIN_SCENE_SECONDS, 6);
  assert.equal(MAX_SCENE_SECONDS, 20);
  assert.deepEqual(sceneBoundsFor(30), { minScenes: 1, maxScenes: 5 });
  assert.deepEqual(sceneBoundsFor(120), { minScenes: 6, maxScenes: 20 });
  assert.deepEqual(sceneBoundsFor(600), { minScenes: 30, maxScenes: 100 });

  assert.deepEqual(validateSceneDensity({ sceneCount: 12, durationSeconds: 120 }), []);
  assert.equal(validateSceneDensity({ sceneCount: 5, durationSeconds: 120 })[0]?.rule, "blueprint-scene-density-low");
  assert.equal(validateSceneDensity({ sceneCount: 21, durationSeconds: 120 })[0]?.rule, "blueprint-scene-density-high");
  assert.equal(validateSceneDensity({ sceneCount: 10, durationSeconds: 600 })[0]?.rule, "blueprint-scene-density-low");
  assert.deepEqual(validateSceneDensity({ sceneCount: 30, durationSeconds: 600 }), []);
  assert.equal(validateSceneDensity({ sceneCount: 8, durationSeconds: 30 })[0]?.rule, "blueprint-scene-density-high");
  console.log("  Flaw 2: density bounds 30/120/600s, low/high rules fire, in-corridor counts pass");

  // --- Flaw 3: critical-claim budget + per-scene cap ---
  assert.equal(CRITICAL_CLAIMS_PER_MINUTE, 8);
  assert.equal(criticalClaimBudget(60), 8);
  assert.equal(criticalClaimBudget(120), 16);
  assert.deepEqual(validateClaimBudget({ criticalClaimCount: 8, durationSeconds: 60 }), []);
  const exceeded = validateClaimBudget({ criticalClaimCount: 25, durationSeconds: 60 });
  assert.equal(exceeded[0]?.rule, "blueprint-claim-budget-exceeded");
  assert.equal(exceeded[0]?.evidence.budget, 8);
  assert.match(exceeded[0]!.remediation, /never dropped/, "budget remediation must never instruct dropping a critical claim");

  assert.equal(MAX_CLAIMS_PER_SCENE, 3);
  assert.deepEqual(validateClaimsPerScene({ scenes: [{ id: "s1", claimIds: ["a", "b", "c"] }] }), []);
  const crowded = validateClaimsPerScene({ scenes: [{ id: "s1", claimIds: ["a", "b", "c", "d"] }] });
  assert.equal(crowded[0]?.rule, "blueprint-scene-claim-overcrowded");
  assert.equal(crowded[0]?.evidence.claimCount, 4);
  console.log("  Flaw 3: 8 critical claims/60s allowed, 25 rejected pre-generation; scenes capped at 3 claims");

  // --- Flaws 4/6: visual-beat validation ---
  const tamil = "இலை ஒளிச்சேர்க்கையை விளக்குகிறது";
  assert.equal(isNonEnglishScript(tamil), true);
  assert.equal(validateVisualBeat(tamil)[0]?.rule, "blueprint-visual-beat-localized");
  assert.equal(validateVisualBeat("Show video")[0]?.rule, "blueprint-visual-beat-vague", "a two-word beat is vague");
  assert.equal(validateVisualBeat("The process explains how plants make sugar from light")[0]?.rule, "blueprint-visual-beat-nonDirective", "a descriptive translation with no canvas verb is non-directive");
  assert.deepEqual(validateVisualBeat("Reveal the leaf cross-section, then trace light energy into the chloroplast"), []);
  assert.equal(hasVisualDirectionKeyword("Reveal the leaf"), true);
  assert.equal(hasVisualDirectionKeyword("The process explains"), false);
  assert.equal(isNonEnglishScript("label the \u03b2-carbon"), false, "Greek scientific notation is not a localization finding");
  assert.ok(VISUAL_BEAT_PROMPT_RULES.includes("strictly in English"), "the prompt rule must state the English visualBeat requirement");
  console.log("  Flaws 4/6: Tamil → localized, \"Show video\" → vague, prose → non-directive, directed English beat passes");

  // --- Flaw 5: bounded repair loop, oscillation then accept on attempt 3 ---
  const corrections: BlueprintCorrection[] = [];
  const attempts: Array<{ outcome: string; missingClaimIds: string[]; failedRules: string[] }> = [];
  const accepted = await runBoundedBlueprintRepairLoop({
    generate: async (correction) => {
      if (correction) corrections.push(correction);
      const missing = correction?.missingClaimIds ?? [];
      if (missing.includes("claim-c02") && missing.includes("claim-c04")) return planWith(["claim-c02", "claim-c04"]);
      if (missing.includes("claim-c02")) return planWith(["claim-c02"]);
      return planWith(["claim-c04"]);
    },
    verify: verifyCoverage,
    onAttempt: (attempt) => {
      attempts.push({ outcome: attempt.outcome, missingClaimIds: attempt.missingClaimIds, failedRules: attempt.failedRules });
    },
  });
  assert.deepEqual(attempts.map((entry) => entry.outcome), ["rejected-by-qa", "rejected-by-qa", "completed"]);
  assert.deepEqual(attempts[0]!.missingClaimIds, ["claim-c02"]);
  assert.deepEqual(attempts[1]!.missingClaimIds, ["claim-c04"]);
  assert.equal(corrections.length, 2, "the generator must be re-run with a correction after each rejection");
  assert.deepEqual([...corrections[1]!.missingClaimIds].sort(), ["claim-c02", "claim-c04"], "the correction must accumulate the union of missing ids");
  assert.deepEqual(corrections[1]!.failedRules, ["blueprint-objective-coverage"]);
  assert.deepEqual(accepted.value.covered, ["claim-c02", "claim-c04"]);
  const repairPrompt = buildBlueprintRepairPrompt({ correction: corrections[1]!, previous: planWith(["claim-c02"]) });
  assert.match(repairPrompt, /claim-c02/);
  assert.match(repairPrompt, /claim-c04/);
  assert.match(repairPrompt, /strictly in English/);
  console.log(`  Flaw 5: oscillating repair sequence ${attempts.map((entry) => entry.outcome).join(" → ")}; attempt 3 covers the accumulated union`);

  // --- Flaw 5: terminal exhaustion at MAX_BLUEPRINT_ATTEMPTS ---
  const exhaustionOutcomes: string[] = [];
  let terminal: unknown = null;
  try {
    await runBoundedBlueprintRepairLoop({
      generate: async () => planWith([]),
      verify: verifyCoverage,
      onAttempt: (attempt) => {
        exhaustionOutcomes.push(attempt.outcome);
      },
    });
  } catch (error) {
    terminal = error;
  }
  assert.ok(terminal instanceof BlueprintQaExhaustedError, "exhaustion must throw the terminal BlueprintQaExhaustedError");
  assert.equal((terminal as BlueprintQaExhaustedError).code, BLUEPRINT_QA_EXHAUSTED);
  assert.equal((terminal as BlueprintQaExhaustedError).attempts, MAX_BLUEPRINT_ATTEMPTS);
  assert.equal(exhaustionOutcomes.length, MAX_BLUEPRINT_ATTEMPTS);
  assert.ok(exhaustionOutcomes.every((outcome) => outcome === "rejected-by-qa"));
  assert.deepEqual([...(terminal as BlueprintQaExhaustedError).lastMissingClaimIds].sort(), ["claim-c02", "claim-c04"]);
  assert.ok(!(terminal instanceof BlueprintQaRejectionError));
  console.log(`  Flaw 5: exhaustion ${exhaustionOutcomes.join(" → ")} (terminal ${BLUEPRINT_QA_EXHAUSTED})`);

  // --- Flaw 1: composite input hash binds the blueprint to the snapshot ---
  const factPack = { schemaVersion: "verified-fact-pack/v1", claims: [{ id: "c1", text: "Leaves contain chlorophyll." }] };
  const snapshotHash = "a".repeat(64);
  const composite = blueprintInputHash(factPack, snapshotHash);
  assert.equal(composite, localSha([factPack, snapshotHash]), "the composite hash must be sha([factPack, snapshotHash])");
  assert.equal(composite, blueprintInputHash(factPack, snapshotHash));
  assert.notEqual(composite, blueprintInputHash(factPack, "b".repeat(64)), "a different snapshot must change the input hash");
  assert.notEqual(composite, blueprintInputHash({ ...factPack, claims: [] }, snapshotHash), "a different fact pack must change the input hash");
  assert.notEqual(composite, localSha(factPack), "the composite must differ from the fact-pack-only hash the handler used before");
  console.log("  Flaw 1: composite hash = sha([factPack, snapshotHash]) and changes with either input");

  console.log("s04 PASS");
};

main().catch((error) => {
  console.error("s04 FAIL:", error);
  process.exit(1);
});
