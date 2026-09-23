import { describe, expect, it } from "vitest";
import {
  BLUEPRINT_QA_EXHAUSTED,
  MAX_BLUEPRINT_ATTEMPTS,
  BlueprintQaExhaustedError,
  BlueprintQaRejectionError,
  buildBlueprintRepairPrompt,
  runBoundedBlueprintRepairLoop,
  type BlueprintCorrection,
} from "../src/blueprint-repair.ts";

const requiredClaims = ["claim-c02", "claim-c04"];
const planWith = (covered: string[]) => ({ covered });

const verifyCoverage = (plan: { covered: string[] }): void => {
  const missing = requiredClaims.filter((id) => !plan.covered.includes(id));
  if (missing.length) {
    throw new BlueprintQaRejectionError({
      issues: [{ rule: "blueprint-objective-coverage", evidence: { uncoveredCritical: missing }, remediation: "Add a scene that teaches every critical claim." }],
      missingClaimIds: missing,
      rationale: `critical claims uncovered: ${missing.join(", ")}`,
    });
  }
};

describe("bounded blueprint repair loop", () => {
  it("repairs an oscillating plan on attempt 3 using the accumulated missing claim ids", async () => {
    const corrections: BlueprintCorrection[] = [];
    const outcomes: string[] = [];
    const result = await runBoundedBlueprintRepairLoop({
      generate: async (correction) => {
        if (correction) corrections.push(correction);
        const missing = correction?.missingClaimIds ?? [];
        if (missing.includes("claim-c02") && missing.includes("claim-c04")) return planWith(["claim-c02", "claim-c04"]);
        if (missing.includes("claim-c02")) return planWith(["claim-c02"]);
        return planWith(["claim-c04"]);
      },
      verify: verifyCoverage,
      onAttempt: (attempt) => {
        outcomes.push(attempt.outcome);
      },
    });

    expect(outcomes).toEqual(["rejected-by-qa", "rejected-by-qa", "completed"]);
    expect(corrections).toHaveLength(2);
    expect([...corrections[1]!.missingClaimIds].sort()).toEqual(["claim-c02", "claim-c04"]);
    expect(corrections[1]!.failedRules).toEqual(["blueprint-objective-coverage"]);
    expect(result.value.covered).toEqual(["claim-c02", "claim-c04"]);
  });

  it("names the missing claim ids and the language rule in the repair prompt", async () => {
    let captured: BlueprintCorrection | null = null;
    await runBoundedBlueprintRepairLoop({
      maxAttempts: 2,
      generate: async (correction) => {
        if (correction) captured = correction;
        return planWith(["claim-c04"]);
      },
      verify: verifyCoverage,
    }).catch(() => undefined);
    const prompt = buildBlueprintRepairPrompt({ correction: captured!, previous: planWith(["claim-c04"]) });
    expect(prompt).toContain("claim-c02");
    expect(prompt).toContain("claim-c04");
    expect(prompt).toContain("strictly in English");
  });

  it("fails terminally with BLUEPRINT_QA_EXHAUSTED after the bounded attempts", async () => {
    const outcomes: string[] = [];
    let terminal: unknown = null;
    try {
      await runBoundedBlueprintRepairLoop({
        generate: async () => planWith([]),
        verify: verifyCoverage,
        onAttempt: (attempt) => {
          outcomes.push(attempt.outcome);
        },
      });
    } catch (error) {
      terminal = error;
    }
    expect(terminal).toBeInstanceOf(BlueprintQaExhaustedError);
    expect((terminal as BlueprintQaExhaustedError).code).toBe(BLUEPRINT_QA_EXHAUSTED);
    expect((terminal as BlueprintQaExhaustedError).attempts).toBe(MAX_BLUEPRINT_ATTEMPTS);
    expect(outcomes).toEqual(["rejected-by-qa", "rejected-by-qa", "rejected-by-qa"]);
    expect([...(terminal as BlueprintQaExhaustedError).lastMissingClaimIds].sort()).toEqual(["claim-c02", "claim-c04"]);
  });
});
